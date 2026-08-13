import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquirePermitResponse } from "../index.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = await fs.readFile(path.join(root, "index.ts"), "utf8");

function loadResolveGroup(isSubagentChild, inheritedGroup) {
  const match = source.match(/function resolveGroup\(ctx: any\): string \{([\s\S]*?)\n\}/);
  assert(match, "resolveGroup implementation was not found");
  return (ctx) => Function(
    "IS_SUBAGENT_CHILD",
    "INHERITED_GROUP",
    "ctx",
    match[1],
  )(isSubagentChild, inheritedGroup, ctx);
}

function context(sessionId) {
  return { sessionManager: { getSessionId: () => sessionId } };
}

test("only recognized subagent children inherit an orchestration group", () => {
  assert.equal(loadResolveGroup(true, "parent-root")(context("child-leaf")), "parent-root");
  assert.equal(loadResolveGroup(false, "stale-root")(context("top-level")), "top-level");
  assert.equal(loadResolveGroup(true, "")(context("child-without-root")), "child-without-root");
});

test("non-Codex parents export their group before the provider guard", () => {
  const exportPosition = source.indexOf("process.env[GROUP_ENV] = group;");
  const providerGuardPosition = source.indexOf('if (ctx.model?.provider !== "openai-codex") return;');
  assert(exportPosition >= 0, "group export is missing");
  assert(providerGuardPosition >= 0, "provider guard is missing");
  assert(exportPosition < providerGuardPosition, "provider guard prevents parent group export");
});

test("permit acquisition remains pending instead of returning control to the provider", async () => {
  let requests = 0;
  let warnings = 0;
  let transportCalls = 0;
  const never = new Promise(() => {});

  // Model Pi's runner: provider transport happens only after the hook resolves.
  const hostRun = (async () => {
    await acquirePermitResponse({ group: "root", session: "leaf" }, "/unused", {
      warningAfterAttempts: 3,
      retryMs: 1,
      request: async () => { requests++; return { retry: true }; },
      ensure: async () => {},
      wait: async () => requests >= 3 ? never : undefined,
      onUnavailable: () => { warnings++; },
    });
    transportCalls++;
  })();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 3);
  assert.equal(warnings, 1);
  assert.equal(transportCalls, 0);
  const outcome = await Promise.race([
    hostRun.then(() => "returned"),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 20)),
  ]);
  assert.equal(outcome, "still-pending");
  assert.equal(transportCalls, 0);
});

test("permit acquisition can recover after reporting prolonged unavailability", async () => {
  let requests = 0;
  let warnings = 0;
  const response = await acquirePermitResponse({ group: "root", session: "leaf" }, "/unused", {
    warningAfterAttempts: 3,
    retryMs: 1,
    request: async () => ++requests === 4 ? { permitId: "recovered" } : { retry: true },
    ensure: async () => {},
    wait: async () => {},
    onUnavailable: () => { warnings++; },
  });
  assert.equal(response.permitId, "recovered");
  assert.equal(requests, 4);
  assert.equal(warnings, 1);
});

test("aborting an acquire stops the in-flight request and retry loop", async () => {
  const controller = new AbortController();
  let requests = 0;
  const pending = acquirePermitResponse({ group: "root", session: "leaf" }, "/unused", {
    signal: controller.signal,
    request: async (_path, _body, signal) => {
      requests++;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
    },
    ensure: async () => { throw new Error("must not retry after abort"); },
    wait: async () => { throw new Error("must not sleep after abort"); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(requests, 1);
});
