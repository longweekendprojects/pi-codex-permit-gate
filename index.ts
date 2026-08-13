// OpenAI Codex permit gate.
//
// Mirrors the Claude lane permit behavior for the built-in openai-codex
// provider, without lanes: before a Codex request goes out, the session
// acquires a permit from a local daemon that caps cross-session concurrency.
// When the daemon is out of permits the request waits in the daemon's queue
// instead of hitting OpenAI and bouncing off a transient backend error.
// Rate-limit and transient Codex errors briefly throttle the gate, and the
// gate raises concurrency again after a clean window. It does not proxy HTTP,
// does not touch credentials, and does not modify the provider payload.
// Non-Codex providers bypass it entirely.
//
// Requests are scheduled round-robin across orchestration groups, so a session
// that fans out many Codex subagents gets one share overall rather than one per
// child process. A subagent inherits its parent's group through
// CODEX_PERMIT_GATE_GROUP; set that variable by hand only to deliberately join
// an existing group.
//
// Enabled by default. Opt out for a session:
//   CODEX_PERMIT_GATE_DISABLE=1 pi
//
// Tune the concurrency envelope (read by the daemon on first spawn):
//   CODEX_PERMIT_GATE_MAX=1 CODEX_PERMIT_GATE_START=1 pi
// Kill the daemon (it restarts on demand) after changing these:
//   pkill -f codex-permit-gate/permit-daemon.mjs
//
// Inspect the gate in-session:
//   /codex-permit

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DISABLED = process.env.CODEX_PERMIT_GATE_DISABLE === "1";
const PORT = parseInt(process.env.CODEX_PERMIT_GATE_PORT || "8795", 10);
const BASE = `http://127.0.0.1:${PORT}`;
const VERBOSE = process.env.CODEX_PERMIT_GATE_VERBOSE === "1";
const GROUP_ENV = "CODEX_PERMIT_GATE_GROUP";
function positiveEnvInt(name: string, fallback: number, minimum: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}
const ACQUIRE_WARNING_ATTEMPTS = positiveEnvInt("CODEX_PERMIT_GATE_ACQUIRE_WARNING_ATTEMPTS", 600, 1);
const ACQUIRE_RETRY_MS = positiveEnvInt("CODEX_PERMIT_GATE_ACQUIRE_RETRY_MS", 500, 10);

// Capture the inherited group once, at module load, before this process exports
// its own. Honor it only in a recognized subagent child: any other process may
// have picked the value up from an unrelated pi through the environment, and
// trusting that would silently merge two independent top-level sessions into
// one scheduling lane.
const INHERITED_GROUP = process.env[GROUP_ENV];
const IS_SUBAGENT_CHILD = process.env.PI_SUBAGENT_CHILD === "1";

let activePermit: { permitId: string; renewTimer?: ReturnType<typeof setInterval> } | undefined;
let sessionId = "unknown";
let group = "unknown";

// Scheduling identity is the session id, not the session pathname. Descendants
// live under the root session's directory only in the default layout;
// --session-dir, an explicit --session path, and --no-session all break that,
// and a branched session gets a fresh id. getSessionId() is always present.
//
// Policy for session replacement in a live process: a subagent child keeps its
// spawning root, so process lineage is preserved; a top-level session that runs
// /new, /resume, or /fork becomes its own root, so replacing a session cannot
// keep charging its work to a group the operator has moved on from.
function resolveGroup(ctx: any): string {
  const own = ctx.sessionManager.getSessionId();
  if (IS_SUBAGENT_CHILD && INHERITED_GROUP) return INHERITED_GROUP;
  return own;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getJson<T = any>(pathName = "/health", timeoutMs = 1000): Promise<T | undefined> {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}${pathName}`, { timeout: timeoutMs }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { buf += c; });
      res.on("end", () => { try { resolve(buf ? JSON.parse(buf) : undefined); } catch { resolve(undefined); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(undefined); });
    req.on("error", () => resolve(undefined));
  });
}

function postJson<T = any>(pathName: string, body: any, timeoutMs = 7200000, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const payload = JSON.stringify(body || {});
    const req = http.request(`${BASE}${pathName}`, {
      method: "POST",
      timeout: timeoutMs,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        try { resolve(buf ? JSON.parse(buf) : {}); } catch (err) { reject(err); }
      });
    });
    const abort = () => req.destroy(abortError());
    signal?.addEventListener("abort", abort, { once: true });
    req.on("timeout", () => req.destroy(new Error("permit acquire timed out")));
    req.on("error", reject);
    req.on("close", () => signal?.removeEventListener("abort", abort));
    req.end(payload);
  });
}
function abortError() { return Object.assign(new Error("permit acquisition aborted"), { name: "AbortError" }); }
function isAborted(signal?: AbortSignal) { return signal?.aborted === true; }
function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isAborted(signal)) { reject(abortError()); return; }
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); done(abortError()); };
    function done(error?: Error) { signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function ensureDaemon(dir: string): Promise<void> {
  if ((await getJson())?.ok) return;
  const child = spawn(process.execPath, [path.join(dir, "permit-daemon.mjs")], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CODEX_PERMIT_GATE_PORT: String(PORT) },
  });
  child.unref();
}

type AcquireOptions = {
  warningAfterAttempts?: number;
  retryMs?: number;
  request?: (pathName: string, body: any, signal?: AbortSignal) => Promise<any>;
  ensure?: (dir: string) => Promise<void>;
  wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  onUnavailable?: (message: string) => void;
  signal?: AbortSignal;
};

// Exported for a focused fail-closed test. Production callers use the defaults.
export async function acquirePermitResponse(body: any, dir: string, options: AcquireOptions = {}): Promise<any> {
  const warningAfterAttempts = options.warningAfterAttempts ?? ACQUIRE_WARNING_ATTEMPTS;
  const retryMs = options.retryMs ?? ACQUIRE_RETRY_MS;
  const signal = options.signal;
  const request = options.request ?? ((pathName, payload, requestSignal) => postJson(pathName, payload, 7200000, requestSignal));
  const ensure = options.ensure ?? ensureDaemon;
  const wait = options.wait ?? waitForRetry;
  let warned = false;

  // Pi's before_provider_request runner logs and swallows handler exceptions.
  // Therefore failure must remain pending, not throw: returning control without
  // a permit would let the native provider send the request ungated. Keep
  // retrying across daemon restarts and report prolonged unavailability once.
  for (let attempt = 1; ; attempt++) {
    if (isAborted(signal)) throw abortError();
    let res: any;
    try { res = await request("/acquire", body, signal); } catch (error) {
      if (isAborted(signal) || (error as Error)?.name === "AbortError") throw abortError();
    }
    if (res?.permitId) {
      if (isAborted(signal)) {
        await postJson("/release", { permitId: res.permitId }, 5000).catch(() => {});
        throw abortError();
      }
      return res;
    }

    try { await ensure(dir); } catch {}
    if (!warned && attempt >= warningAfterAttempts) {
      warned = true;
      try {
        options.onUnavailable?.(`Codex permit gate unavailable after ${attempt} attempts; provider request remains blocked`);
      } catch {}
    }
    await wait(retryMs, signal);
  }
}

function startPermitRenewal(permitId: string, permitTtlMs: number): ReturnType<typeof setInterval> | undefined {
  if (!Number.isFinite(permitTtlMs) || permitTtlMs <= 0) return undefined;
  const renewEveryMs = Math.max(10, Math.min(60000, Math.floor(permitTtlMs / 3)));
  const timer = setInterval(async () => {
    if (activePermit?.permitId !== permitId) return;
    try { await postJson("/renew", { permitId }, 5000); } catch {
      // A daemon restart loses lease state. The provider request already owns
      // its permit, so release/error handling remains best-effort as before.
    }
  }, renewEveryMs);
  timer.unref?.();
  return timer;
}

async function acquirePermit(ctx: any, dir: string): Promise<void> {
  if (activePermit || isAborted(ctx.signal)) return;
  ctx.ui?.setStatus?.("codex-permit-gate", "Codex: waiting for permit...");
  try {
    const res = await acquirePermitResponse({ group, session: sessionId, cwd: ctx.cwd }, dir, {
      signal: ctx.signal,
      onUnavailable: (message) => {
        ctx.ui?.setStatus?.("codex-permit-gate", "Codex: blocked; permit gate unavailable");
        ctx.ui?.notify?.(message, "error");
      },
    });
    if (isAborted(ctx.signal)) {
      await postJson("/release", { permitId: res.permitId }, 5000).catch(() => {});
      return;
    }
    const permitId = String(res.permitId);
    activePermit = { permitId };
    activePermit.renewTimer = startPermitRenewal(permitId, Number(res.permitTtlMs || 0));
    const waited = Number(res.waitedMs || 0);
    ctx.ui?.setStatus?.("codex-permit-gate", waited > 1000 ? `Codex: permit after ${Math.round(waited / 1000)}s` : "Codex: permit active");
    if (VERBOSE) ctx.ui?.notify?.(`Codex permit granted after ${waited}ms`, "info");
  } catch (error) {
    if (!isAborted(ctx.signal) && (error as Error)?.name !== "AbortError") throw error;
  } finally {
    if (isAborted(ctx.signal)) ctx.ui?.setStatus?.("codex-permit-gate", undefined);
  }
}

async function releasePermit(throttle: boolean, reason: string, cooldownMs?: number): Promise<void> {
  const p = activePermit;
  if (!p) return;
  activePermit = undefined;
  if (p.renewTimer) clearInterval(p.renewTimer);
  try {
    await postJson(throttle ? "/throttle" : "/release", { permitId: p.permitId, reason, cooldownMs }, 5000);
  } catch {
    // The daemon may have restarted; do not block the session on release cleanup.
  }
}

type ProviderFailure = "rate-limit" | "overloaded";
function classifyProviderFailure(message: any): ProviderFailure | undefined {
  if (message?.stopReason !== "error" || !message?.errorMessage) return undefined;
  const text = String(message.errorMessage);
  // Codex surfaces backend overload as a generic "an error occurred while
  // processing your request" with a request ID; treat it as overload pacing.
  if (/overloaded|an error occurred while processing your request|bad gateway|service unavailable|502|503|500/i.test(text)) return "overloaded";
  if (/rate.?limit|rate_limit|too many requests|429/i.test(text) && !/quota|billing|balance|insufficient/i.test(text)) return "rate-limit";
  return undefined;
}
function cooldownForFailure(failure: ProviderFailure): number {
  // Short pacing after a provider throttle. A cooldown stops every session, so
  // it is charged to the whole machine: one transient must not cost minutes of
  // queue time across every lane. Concurrency backoff, not a long freeze, is the
  // real control, and Pi's own retry absorbs the occasional failure.
  if (failure === "overloaded") return Number(process.env.CODEX_PERMIT_GATE_OVERLOADED_COOLDOWN_MS || 8 * 1000);
  return Number(process.env.CODEX_PERMIT_GATE_RATE_LIMIT_COOLDOWN_MS || 10 * 1000);
}

export default async function (pi: ExtensionAPI) {
  if (DISABLED) return;

  const dir = path.dirname(fileURLToPath(import.meta.url));

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    group = resolveGroup(ctx);
    // Export unconditionally, before any provider check: a Claude or local-model
    // parent still has to hand its group to Codex children it spawns.
    process.env[GROUP_ENV] = group;
    if (ctx.model?.provider !== "openai-codex") return;
    await ensureDaemon(dir);
    if (ctx.hasUI) ctx.ui.setStatus("codex-permit-gate", "Codex gate: ready");
  });

  pi.on("model_select", async (event: any, ctx: any) => {
    if (!ctx.hasUI) return;
    if (event.model?.provider === "openai-codex") ctx.ui.setStatus("codex-permit-gate", "Codex gate: ready");
    else ctx.ui.setStatus("codex-permit-gate", undefined);
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    const model = ctx.model;
    if (!model || model.provider !== "openai-codex") return undefined;
    await ensureDaemon(dir);
    await acquirePermit(ctx, dir);
    return undefined;
  });

  pi.on("message_end", async (event, ctx) => {
    if (!activePermit || event.message.role !== "assistant") return undefined;
    const failure = classifyProviderFailure(event.message);
    await releasePermit(!!failure, failure ? `assistant-${failure}` : "assistant-end", failure ? cooldownForFailure(failure) : undefined);
    if (ctx.hasUI && ctx.model?.provider === "openai-codex") ctx.ui.setStatus("codex-permit-gate", "Codex gate: ready");
    return undefined;
  });

  pi.on("agent_end", async () => { await releasePermit(false, "agent-end"); });
  pi.on("session_shutdown", async () => { await releasePermit(false, "session-shutdown"); });

  pi.registerCommand("codex-permit", {
    description: "Show the Codex permit gate status: /codex-permit",
    handler: async (_args, ctx) => {
      const h = await getJson("/health");
      if (!h?.ok) {
        ctx.ui.notify(`Codex permit gate: daemon stopped on 127.0.0.1:${PORT} (starts on the next Codex request).`, "warning");
        return;
      }
      const groups = Object.entries(h.groups || {}) as [string, any][];
      const groupLines = groups
        .sort((a, b) => Number(b[1].queued || 0) - Number(a[1].queued || 0))
        .map(([id, g]) => {
          const mark = id === group ? "*" : " ";
          const wait = Math.round(Number(g.oldestWaitMs || 0) / 1000);
          const sessions = Number(g.sessions?.length || 0);
          return `  ${mark} ${id}: active ${g.active}, queued ${g.queued}${sessions > 1 ? ` (${sessions} sessions)` : ""}, granted ${g.granted}, oldest wait ${wait}s`;
        });
      ctx.ui.notify(
        [
          `Codex permit gate (127.0.0.1:${PORT}):`,
          `  concurrency ${h.current}/${h.max}, active ${h.active}, queued ${h.queued}`,
          `  cooldown remaining ${Math.round(Number(h.cooldownMsRemaining || 0) / 1000)}s`,
          `  granted ${h.granted}, released ${h.released}, throttles ${h.throttles}, expired ${h.expired}`,
          `  peak active ${h.peakActive}, peak queued ${h.peakQueued}, peak wait ${Math.round(Number(h.peakOldestWaitMs || 0) / 1000)}s`,
          groupLines.length ? "Groups (one per top-level session; * = this session):" : "Groups: none active",
          ...groupLines,
        ].join("\n"),
        "info",
      );
    },
  });
}
