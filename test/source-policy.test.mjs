import assert from "node:assert/strict";
import test from "node:test";
import permitGate, {
  acquirePermitResponse,
  parseProviderPorts,
  providerPort,
  releaseGrantedPermit,
  renewPermit,
  resolveGroup,
} from "../index.ts";

function context(sessionId) {
  return { sessionManager: { getSessionId: () => sessionId } };
}

test("only recognized subagent children inherit an orchestration group", () => {
  assert.equal(resolveGroup(context("child-leaf"), "parent-root", true), "parent-root");
  assert.equal(resolveGroup(context("top-level"), "stale-root", false), "top-level");
  assert.equal(resolveGroup(context("child-without-root"), "", true), "child-without-root");
});

test("unmapped parents export their group", async () => {
  const handlers = new Map();
  await permitGate({
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
  });
  const previousGroup = process.env.CODEX_PERMIT_GATE_GROUP;
  try {
    await handlers.get("session_start")({}, {
      ...context("local-root"),
      model: { provider: "local-model" },
      hasUI: false,
    });
    assert.equal(process.env.CODEX_PERMIT_GATE_GROUP, resolveGroup(context("local-root")));
  } finally {
    if (previousGroup === undefined) delete process.env.CODEX_PERMIT_GATE_GROUP;
    else process.env.CODEX_PERMIT_GATE_GROUP = previousGroup;
  }
});

test("provider-port mapping uses defaults only when unset and fails closed for malformed explicit maps", () => {
  assert.deepEqual([...parseProviderPorts(undefined)], [
    ["openai-codex", 8795],
    ["openai-codex-a", 8796],
    ["openai-codex-b", 8797],
  ]);
  const explicitPorts = parseProviderPorts("openai-codex-a:9001,custom.pool:65535");
  assert.deepEqual([...explicitPorts], [
    ["openai-codex-a", 9001],
    ["custom.pool", 65535],
  ]);
  assert.equal(providerPort("openai-codex", explicitPorts), undefined);
  assert.equal(providerPort("openai-codex-b", explicitPorts), undefined);
  assert.deepEqual([...parseProviderPorts("")], []);

  for (const value of ["openai-codex:9000, invalid", "openai-codex-a:0,custom.pool:65535", "openai-codex-b:65536"]) {
    const ports = parseProviderPorts(value);
    assert.deepEqual([...ports], [], `${value} must not retain a partial map`);
    for (const provider of ["openai-codex", "openai-codex-a", "openai-codex-b"]) {
      assert.equal(providerPort(provider, ports), undefined, `${value} must block ${provider}`);
    }
  }
});

test("granted permits keep their original port for renewal, release, throttling, and abort cleanup", async () => {
  const calls = [];
  const post = async (port, pathName, body, timeoutMs) => { calls.push({ port, pathName, body, timeoutMs }); };
  const permit = { permitId: "granted-on-b", port: 8797 };

  await renewPermit(permit, post);
  await releaseGrantedPermit(permit, false, "assistant-end", undefined, post);
  await releaseGrantedPermit(permit, true, "assistant-rate-limit", 1000, post);

  const controller = new AbortController();
  await assert.rejects(acquirePermitResponse({}, "/unused", {
    port: permit.port,
    signal: controller.signal,
    request: async () => { controller.abort(); return { permitId: "aborted-after-grant" }; },
    release: async (port, permitId) => { calls.push({ port, pathName: "/release", body: { permitId }, timeoutMs: 5000 }); },
  }), { name: "AbortError" });

  assert.deepEqual(calls, [
    { port: 8797, pathName: "/renew", body: { permitId: "granted-on-b" }, timeoutMs: 5000 },
    { port: 8797, pathName: "/release", body: { permitId: "granted-on-b", reason: "assistant-end", cooldownMs: undefined }, timeoutMs: 5000 },
    { port: 8797, pathName: "/throttle", body: { permitId: "granted-on-b", reason: "assistant-rate-limit", cooldownMs: 1000 }, timeoutMs: 5000 },
    { port: 8797, pathName: "/release", body: { permitId: "aborted-after-grant" }, timeoutMs: 5000 },
  ]);
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
