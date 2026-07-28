#!/usr/bin/env node
// OpenAI Codex permit daemon.
//
// Coordinates cross-session Codex concurrency without proxying HTTP traffic.
// Clients ask for a permit before they call OpenAI directly. If no permit is
// available, they wait here before any provider HTTP request exists, so no
// gateway/proxy timeout can occur. This mirrors the Claude lane permit daemon,
// with its own port, env prefix, and log directory.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const PORT = parseInt(process.env.CODEX_PERMIT_GATE_PORT || "8795", 10);
const MIN = Math.max(1, parseInt(process.env.CODEX_PERMIT_GATE_MIN || "1", 10));
const MAX = Math.max(MIN, parseInt(process.env.CODEX_PERMIT_GATE_MAX || "1", 10));
let current = Math.min(MAX, Math.max(MIN, parseInt(process.env.CODEX_PERMIT_GATE_START || "1", 10)));
const COOLDOWN_MS = Math.max(1000, parseInt(process.env.CODEX_PERMIT_GATE_COOLDOWN_MS || "20000", 10));
// Hard ceiling on any single cooldown, so one throttle (or a stale client that
// still asks for a multi-minute cooldown) can never freeze an idle lane for
// minutes. A throttle paces the next grant; it does not take the lane offline.
const MAX_COOLDOWN_MS = Math.max(1000, parseInt(process.env.CODEX_PERMIT_GATE_MAX_COOLDOWN_MS || "60000", 10));
const INCREASE_AFTER_MS = Math.max(10000, parseInt(process.env.CODEX_PERMIT_GATE_INCREASE_AFTER_MS || "120000", 10));
// A granted permit whose client stops renewing is auto-reclaimed after this
// long. Live clients renew while their provider request runs, so request age
// alone never creates a second concurrent grant.
const PERMIT_TTL_MS = Math.max(0, parseInt(process.env.CODEX_PERMIT_GATE_PERMIT_TTL_MS || "300000", 10));
const DIR = path.join(os.homedir(), ".pi", "agent", "codex-permit-gate");
const LOG = path.join(DIR, "permit-daemon.log");
try { fs.mkdirSync(DIR, { recursive: true }); } catch {}

const stats = {
  startedAt: new Date().toISOString(),
  granted: 0,
  released: 0,
  cancelled: 0,
  expired: 0,
  throttles: 0,
  peakActive: 0,
  peakQueued: 0,
  peakOldestWaitMs: 0,
};

const active = new Map(); // permitId -> {group, session, grantedAt, renewedAt}
const lanes = new Map(); // group -> request[]
const grantsByGroup = new Map(); // group -> cumulative grants, for round-robin fairness auditing
const rr = [];
let cooldownUntil = 0;
let lastThrottleAt = 0;
let lastIncreaseAt = Date.now();
let pumpTimer;

function log(...args) {
  fs.appendFile(LOG, `[${new Date().toISOString()}] [:${PORT}] ${args.map(String).join(" ")}\n`, () => {});
}
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => s += c);
    req.on("end", () => {
      try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); }
    });
  });
}
// Report full group identifiers, never truncated: a collision between two roots
// and a failure to propagate a group to descendants look identical once the ids
// are shortened, and those are exactly the two failures this scheduler can have.
function snapshot() {
  let queued = 0;
  let oldestWaitMs = 0;
  const groups = {};
  const now = Date.now();
  const ensure = (g) => (groups[g] ||= { queued: 0, active: 0, granted: grantsByGroup.get(g) || 0, oldestWaitMs: 0, sessions: [] });
  for (const [g, q] of lanes) {
    if (!q.length) continue;
    queued += q.length;
    const entry = ensure(g);
    entry.queued = q.length;
    entry.oldestWaitMs = now - q[0].enqueuedAt;
    entry.sessions = [...new Set(q.map((r) => r.session))];
    oldestWaitMs = Math.max(oldestWaitMs, entry.oldestWaitMs);
  }
  for (const info of active.values()) ensure(info.group).active++;
  for (const g of grantsByGroup.keys()) ensure(g);
  stats.peakQueued = Math.max(stats.peakQueued, queued);
  stats.peakOldestWaitMs = Math.max(stats.peakOldestWaitMs, oldestWaitMs);
  return { queued, oldestWaitMs, groups };
}
function schedulePump(ms) {
  if (pumpTimer) return;
  pumpTimer = setTimeout(() => { pumpTimer = undefined; pump(); }, Math.max(0, ms));
}
// Queues are keyed by orchestration group, not by session. A parent and every
// subagent it spawns share one queue, so a wide fanout can no longer create
// extra scheduling identities and outvote another top-level session.
function enqueue(group, session, res) {
  const req = { group, session, enqueuedAt: Date.now(), res, done: false };
  let q = lanes.get(group);
  if (!q) { q = []; lanes.set(group, q); }
  q.push(req);
  if (!rr.includes(group)) rr.push(group);
  req.cancel = () => {
    if (req.done) return;
    req.done = true;
    const q = lanes.get(group);
    if (q) {
      const i = q.indexOf(req);
      if (i >= 0) q.splice(i, 1);
      if (!q.length) {
        lanes.delete(group);
        const ri = rr.indexOf(group);
        if (ri >= 0) rr.splice(ri, 1);
      }
    }
    stats.cancelled++;
  };
  res.on("close", req.cancel);
  pump();
}
function pump() {
  const pause = cooldownUntil - Date.now();
  if (pause > 0) { schedulePump(pause); return; }
  while (active.size < current && rr.length) {
    const group = rr.shift();
    const q = lanes.get(group);
    if (!q || !q.length) continue;
    const req = q.shift();
    if (q.length) rr.push(group);
    else lanes.delete(group);
    if (req.done) continue;
    req.done = true;
    req.res.removeListener("close", req.cancel);
    const permitId = crypto.randomUUID();
    const grantedAt = Date.now();
    active.set(permitId, { group, session: req.session, grantedAt, renewedAt: grantedAt });
    stats.granted++;
    grantsByGroup.set(group, (grantsByGroup.get(group) || 0) + 1);
    stats.peakActive = Math.max(stats.peakActive, active.size);
    json(req.res, 200, { ok: true, permitId, waitedMs: Date.now() - req.enqueuedAt, current, max: MAX, permitTtlMs: PERMIT_TTL_MS });
  }
}
function maybeIncrease() {
  const now = Date.now();
  if (current >= MAX) return;
  if (now < cooldownUntil) return;
  if (now - lastThrottleAt < INCREASE_AFTER_MS) return;
  if (now - lastIncreaseAt < INCREASE_AFTER_MS) return;
  const before = current;
  current++;
  lastIncreaseAt = now;
  log(`clean window: concurrency ${before} -> ${current}`);
  pump();
}
function renewPermit(permitId) {
  const info = permitId ? active.get(permitId) : undefined;
  if (!info) return false;
  info.renewedAt = Date.now();
  return true;
}
function releasePermit(permitId) {
  if (!permitId || !active.has(permitId)) return false;
  active.delete(permitId);
  stats.released++;
  maybeIncrease();
  pump();
  return true;
}
function throttle(reason, cooldownMs = COOLDOWN_MS) {
  // Bound every cooldown to MAX_COOLDOWN_MS. This is the backstop that keeps a
  // single throttle (or several sessions each reporting one) from compounding
  // into a multi-minute freeze of an otherwise idle lane.
  const requested = Math.max(1000, Number(cooldownMs) || COOLDOWN_MS);
  const effectiveCooldownMs = Math.min(requested, MAX_COOLDOWN_MS);
  stats.throttles++;
  lastThrottleAt = Date.now();
  // Take the later of the existing window and the new one, still bounded, so a
  // burst of throttles paces rather than ratchets indefinitely.
  cooldownUntil = Math.min(Date.now() + MAX_COOLDOWN_MS, Math.max(cooldownUntil, Date.now() + effectiveCooldownMs));
  const before = current;
  current = Math.max(MIN, current - 1);
  log(`throttle(${reason}): concurrency ${before} -> ${current}; cooldown ${effectiveCooldownMs}ms`);
  schedulePump(effectiveCooldownMs);
}
function sweepStalePermits() {
  if (!PERMIT_TTL_MS) return;
  const now = Date.now();
  let expired = 0;
  for (const [permitId, info] of active) {
    if (now - info.renewedAt > PERMIT_TTL_MS) {
      active.delete(permitId);
      stats.expired++;
      expired++;
    }
  }
  if (expired) {
    log(`reclaimed ${expired} unrenewed permit(s) older than ${PERMIT_TTL_MS}ms`);
    maybeIncrease();
    pump();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    sweepStalePermits();
    const s = snapshot();
    json(res, 200, { ok: true, version: 2, active: active.size, min: MIN, current, max: MAX, cooldownMsRemaining: Math.max(0, cooldownUntil - Date.now()), ...s, ...stats });
    return;
  }
  if (req.method === "POST" && req.url === "/acquire") {
    const b = await body(req);
    const session = String(b.session || "unknown");
    // A client that predates grouping sends only a session; treat it as its own
    // group so an older session still schedules fairly against grouped ones.
    const group = String(b.group || session);
    enqueue(group, session, res);
    return;
  }
  if (req.method === "POST" && req.url === "/renew") {
    const b = await body(req);
    json(res, 200, { ok: renewPermit(b.permitId) });
    return;
  }
  if (req.method === "POST" && req.url === "/release") {
    const b = await body(req);
    json(res, 200, { ok: releasePermit(b.permitId) });
    return;
  }
  if (req.method === "POST" && req.url === "/throttle") {
    const b = await body(req);
    // Set cooldown before releasing the permit so no queued request can slip
    // through in the tiny window between release and throttle.
    throttle(String(b.reason || "unknown"), b.cooldownMs);
    if (b.permitId) releasePermit(b.permitId);
    json(res, 200, { ok: true, current, cooldownMsRemaining: Math.max(0, cooldownUntil - Date.now()) });
    return;
  }
  json(res, 404, { ok: false, error: "not found" });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") process.exit(0);
  log("server error", err.message);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => log(`permit daemon listening on 127.0.0.1:${PORT}; concurrency ${current}/${MAX}; cooldown<=${MAX_COOLDOWN_MS}ms; permitTtl ${PERMIT_TTL_MS}ms`));
const sweepTimer = setInterval(sweepStalePermits, 30000);
if (sweepTimer.unref) sweepTimer.unref();
function gracefulExit() {
  // Tell every still-waiting client to re-acquire from the replacement daemon
  // instead of erroring its turn, so a restart does not interrupt live work.
  for (const [, q] of lanes) {
    for (const req of q) {
      if (req.done) continue;
      req.done = true;
      try { req.res.removeListener("close", req.cancel); json(req.res, 503, { ok: false, retry: true }); } catch {}
    }
  }
  server.close(() => process.exit(0));
  const t = setTimeout(() => process.exit(0), 500);
  if (t.unref) t.unref();
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, gracefulExit);
