import assert from "node:assert/strict";
import test from "node:test";
import permitGate, {
  acquirePermitResponse,
  gateDecision,
  parseProviderPorts,
  releaseGrantedPermit,
  renewPermit,
  resolveGroup,
} from "../index.ts";

function context(sessionId) {
  return { sessionManager: { getSessionId: () => sessionId } };
}

let configImport = 0;
async function loadConfiguredGate(providerPorts) {
  const previous = process.env.CODEX_PERMIT_GATE_PROVIDER_PORTS;
  process.env.CODEX_PERMIT_GATE_PROVIDER_PORTS = providerPorts;
  try {
    return await import(`../index.ts?provider-ports-test=${configImport++}`);
  } finally {
    if (previous === undefined) delete process.env.CODEX_PERMIT_GATE_PROVIDER_PORTS;
    else process.env.CODEX_PERMIT_GATE_PROVIDER_PORTS = previous;
  }
}

async function hookHandlers(gate) {
  const handlers = new Map();
  await gate({
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
  });
  return handlers;
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

test("provider-port configuration distinguishes defaults, valid omissions, and invalid blocks", () => {
  const defaults = parseProviderPorts(undefined);
  assert.equal(defaults.kind, "valid");
  assert.deepEqual([...defaults.ports], [
    ["openai-codex", 8795],
    ["openai-codex-a", 8796],
    ["openai-codex-b", 8797],
  ]);
  assert.deepEqual(gateDecision(undefined, defaults), { kind: "bypass" });

  const explicit = parseProviderPorts("openai-codex-a:9001,custom.pool:65535");
  assert.equal(explicit.kind, "valid");
  assert.deepEqual([...explicit.ports], [
    ["openai-codex-a", 9001],
    ["custom.pool", 65535],
  ]);
  assert.deepEqual(gateDecision("openai-codex", explicit), { kind: "bypass" });
  assert.deepEqual(gateDecision("openai-codex-b", explicit), { kind: "bypass" });
  assert.deepEqual(gateDecision("openai-codex-a", explicit), { kind: "gate", port: 9001 });

  const empty = parseProviderPorts("");
  assert.equal(empty.kind, "valid");
  assert.deepEqual([...empty.ports], []);

  for (const value of ["openai-codex:9000, invalid", "openai-codex-a:0,custom.pool:65535", "openai-codex-b:65536"]) {
    const config = parseProviderPorts(value);
    assert.equal(config.kind, "invalid", `${value} must not retain a partial map`);
    for (const provider of ["openai-codex", "openai-codex-a", "openai-codex-b"]) {
      assert.equal(gateDecision(provider, config).kind, "block", `${value} must block ${provider}`);
    }
  }
  const customConfig = parseProviderPorts("bad-entry, custom.pool:9001");
  assert.equal(customConfig.kind, "invalid");
  assert.equal(gateDecision("custom.pool", customConfig).kind, "block");
  assert.equal(gateDecision("unrelated-provider", customConfig).kind, "bypass");
});

test("malformed provider-port config blocks built-in Codex requests until abort", async () => {
  const configuredGate = await loadConfiguredGate("openai-codex:9000, bad-entry");
  const handlers = await hookHandlers(configuredGate.default);
  const beforeProviderRequest = handlers.get("before_provider_request");
  const errors = [];

  for (const provider of ["openai-codex", "openai-codex-a", "openai-codex-b"]) {
    const controller = new AbortController();
    const statuses = [];
    const pending = beforeProviderRequest({}, {
      model: { provider },
      signal: controller.signal,
      ui: {
        setStatus: (_name, status) => statuses.push(status),
        notify: (message, level) => errors.push({ message, level }),
      },
    });
    const outcome = await Promise.race([
      pending.then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    assert.equal(outcome, "pending", `${provider} must stay blocked`);
    assert.match(statuses[0], /blocked; invalid CODEX_PERMIT_GATE_PROVIDER_PORTS/);
    controller.abort();
    await pending;
    assert.equal(statuses.at(-1), undefined);
  }

  assert.equal(errors.length, 1);
  assert.equal(errors[0].level, "error");
  assert.match(errors[0].message, /Fix CODEX_PERMIT_GATE_PROVIDER_PORTS and restart Pi, or restart Pi with CODEX_PERMIT_GATE_DISABLE=1 to bypass the gate\./);
});

test("a valid empty provider-port map bypasses requests immediately", async () => {
  const configuredGate = await loadConfiguredGate("");
  const handlers = await hookHandlers(configuredGate.default);
  const notices = [];
  const result = await handlers.get("before_provider_request")({}, {
    model: { provider: "openai-codex" },
    ui: { notify: (...args) => notices.push(args) },
  });
  assert.equal(result, undefined);
  assert.deepEqual(notices, []);
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
