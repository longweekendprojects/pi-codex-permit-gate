import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const daemonPath = path.join(root, "permit-daemon.mjs");
const DEFAULT_PORT = 8795;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  assert.notEqual(port, DEFAULT_PORT, "tests must never use the live daemon port");
  return port;
}

function request(port, method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: pathname,
      timeout: 5000,
      headers: body ? {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      } : undefined,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json;
        try { json = text ? JSON.parse(text) : {}; }
        catch (error) { reject(error); return; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.once("timeout", () => req.destroy(new Error(`request timed out: ${method} ${pathname}`)));
    req.once("error", reject);
    if (body) req.end(body);
    else req.end();
  });
}

const getHealth = (port) => request(port, "GET", "/health").then((response) => response.body);
const acquire = (port, group, session = group) => request(port, "POST", "/acquire", { group, session });
const renew = (port, permitId) => request(port, "POST", "/renew", { permitId });
const release = (port, permitId) => request(port, "POST", "/release", { permitId });

async function waitFor(check, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function startDaemon(overrides = {}) {
  const port = overrides.CODEX_PERMIT_GATE_PORT
    ? Number(overrides.CODEX_PERMIT_GATE_PORT)
    : await unusedPort();
  assert.notEqual(port, DEFAULT_PORT, "tests must never use the live daemon port");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-codex-permit-gate-test-"));
  const child = spawn(process.execPath, [daemonPath], {
    env: {
      ...process.env,
      HOME: home,
      CODEX_PERMIT_GATE_PORT: String(port),
      ...overrides,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitFor(async () => (await getHealth(port)).ok, `daemon did not start${stderr ? ` (${stderr})` : ""}`);
  return {
    port,
    home,
    child,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited(child);
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

async function waitForQueued(port, count) {
  return waitFor(async () => {
    const health = await getHealth(port);
    return health.queued === count ? health : undefined;
  }, `queue did not reach ${count}`);
}

// Most scheduling assertions need a single deterministic slot. Throughput
// behavior is asserted separately, against the shipped defaults.
const SERIALIZED = {
  CODEX_PERMIT_GATE_MIN: "1",
  CODEX_PERMIT_GATE_MAX: "1",
  CODEX_PERMIT_GATE_START: "1",
};

test("shipped defaults keep several requests in flight and never serialize", async (t) => {
  const daemon = await startDaemon();
  t.after(() => daemon.stop());

  const health = await getHealth(daemon.port);
  assert.equal(health.min, 2, "default floor must keep more than one request in flight");
  assert.equal(health.current, 3);
  assert.equal(health.max, 6);

  // Three concurrent holders must all be granted without any queueing.
  const holders = await Promise.all([
    acquire(daemon.port, "root-a"),
    acquire(daemon.port, "root-b"),
    acquire(daemon.port, "root-c"),
  ]);
  for (const holder of holders) assert.equal(holder.status, 200);
  const busy = await getHealth(daemon.port);
  assert.equal(busy.active, 3);
  assert.equal(busy.queued, 0);
  assert.equal(busy.peakActive, 3);

  // Sustained provider failures step concurrency down, but never to one.
  for (let i = 0; i < 6; i++) {
    await request(daemon.port, "POST", "/throttle", { reason: "overloaded", cooldownMs: 1000 });
  }
  const throttled = await getHealth(daemon.port);
  assert.equal(throttled.current, 2, "backoff must stop at the throughput floor");
  assert(throttled.cooldownMsRemaining <= 15000, "a single transient must not freeze lanes for minutes");

  for (const holder of holders) await release(daemon.port, holder.body.permitId);
});

test("daemon enforces one permit and schedules orchestration roots round-robin", async (t) => {
  const daemon = await startDaemon(SERIALIZED);
  t.after(() => daemon.stop());

  const holder = await acquire(daemon.port, "holder", "holder-session");
  assert.equal(holder.status, 200);

  const pending = new Map();
  const enqueue = async (label, group, session, expectedCount) => {
    pending.set(label, acquire(daemon.port, group, session).then((response) => ({ label, group, response })));
    await waitForQueued(daemon.port, expectedCount);
  };

  await enqueue("A1", "A", "A-leaf-1", 1);
  await enqueue("B1", "B", "B-leaf-1", 2);
  await enqueue("C1", "C", "C-leaf-1", 3);
  await enqueue("D1", "D", "D-leaf-1", 4);
  await enqueue("A2", "A", "A-leaf-2", 5);
  await enqueue("B2", "B", "B-leaf-2", 6);
  await enqueue("C2", "C", "C-leaf-2", 7);
  await enqueue("D2", "D", "D-leaf-2", 8);
  for (let i = 3; i <= 8; i++) await enqueue(`A${i}`, "A", `A-leaf-${i}`, i + 6);

  const queuedHealth = await getHealth(daemon.port);
  assert.equal(queuedHealth.active, 1);
  assert.equal(queuedHealth.current, 1);
  assert.equal(queuedHealth.max, 1);
  assert.equal(queuedHealth.peakActive, 1);
  assert.equal(queuedHealth.groups.A.queued, 8);
  assert.equal(new Set(queuedHealth.groups.A.sessions).size, 8);
  assert.deepEqual(Object.keys(queuedHealth.groups).sort(), ["A", "B", "C", "D", "holder"]);

  await release(daemon.port, holder.body.permitId);
  const order = [];
  while (pending.size) {
    const winner = await Promise.race(pending.values());
    pending.delete(winner.label);
    assert.equal(winner.response.status, 200);
    order.push(winner.group);
    await release(daemon.port, winner.response.body.permitId);
  }

  assert.deepEqual(order.slice(0, 8), ["A", "B", "C", "D", "A", "B", "C", "D"]);
  const finalHealth = await getHealth(daemon.port);
  assert.equal(finalHealth.active, 0);
  assert.equal(finalHealth.queued, 0);
  assert.equal(finalHealth.groups.A.granted, 8);
  assert.equal(finalHealth.groups.B.granted, 2);
  assert.equal(finalHealth.groups.C.granted, 2);
  assert.equal(finalHealth.groups.D.granted, 2);
});

test("throttle paces the next grant and unknown releases are idempotent", async (t) => {
  const daemon = await startDaemon(SERIALIZED);
  t.after(() => daemon.stop());

  const first = await acquire(daemon.port, "first");
  const secondPromise = acquire(daemon.port, "second");
  await waitForQueued(daemon.port, 1);

  const unknown = await release(daemon.port, "not-a-permit");
  assert.equal(unknown.body.ok, false);
  assert.equal((await getHealth(daemon.port)).active, 1);

  const startedAt = Date.now();
  const throttled = await request(daemon.port, "POST", "/throttle", {
    permitId: first.body.permitId,
    reason: "test-overload",
    cooldownMs: 1000,
  });
  assert.equal(throttled.body.ok, true);
  assert(throttled.body.cooldownMsRemaining > 0);

  const second = await secondPromise;
  assert(Date.now() - startedAt >= 800, "queued grant ignored the cooldown");
  await release(daemon.port, second.body.permitId);

  const health = await getHealth(daemon.port);
  assert.equal(health.throttles, 1);
  assert.equal(health.active, 0);
  assert.equal(health.queued, 0);
});

test("renewed leases never expire by request age, while abandoned leases are reclaimed", async (t) => {
  const daemon = await startDaemon({ ...SERIALIZED, CODEX_PERMIT_GATE_PERMIT_TTL_MS: "100" });
  t.after(() => daemon.stop());

  const first = await acquire(daemon.port, "live-client");
  assert.equal(first.body.permitTtlMs, 100);
  const waiting = acquire(daemon.port, "next-client");
  await waitForQueued(daemon.port, 1);

  // Keep the request alive for three times its TTL. Health calls trigger the
  // sweep, proving age alone cannot expire a lease that still renews.
  for (let i = 0; i < 5; i++) {
    await delay(60);
    assert.equal((await renew(daemon.port, first.body.permitId)).body.ok, true);
    const health = await getHealth(daemon.port);
    assert.equal(health.expired, 0);
    assert.equal(health.active, 1);
    assert.equal(health.queued, 1);
  }

  // Stop renewing to model a dead client. The next sweep reclaims its lease.
  await delay(130);
  const swept = await getHealth(daemon.port);
  assert.equal(swept.expired, 1);
  const next = await waiting;
  assert.equal(next.status, 200);
  await release(daemon.port, next.body.permitId);
});

test("SIGTERM drains queued clients with an explicit retry response", async () => {
  const daemon = await startDaemon(SERIALIZED);
  const first = await acquire(daemon.port, "active");
  assert(first.body.permitId);
  const waiting = acquire(daemon.port, "queued");
  await waitForQueued(daemon.port, 1);

  daemon.child.kill("SIGTERM");
  const response = await waiting;
  assert.equal(response.status, 503);
  assert.equal(response.body.retry, true);
  await exited(daemon.child);
  await fs.rm(daemon.home, { recursive: true, force: true });
});

test("a second daemon on the same port exits cleanly without replacing the first", async (t) => {
  const daemon = await startDaemon(SERIALIZED);
  t.after(() => daemon.stop());

  const second = spawn(process.execPath, [daemonPath], {
    env: {
      ...process.env,
      HOME: daemon.home,
      CODEX_PERMIT_GATE_PORT: String(daemon.port),
    },
    stdio: "ignore",
  });
  const result = await exited(second);
  assert.equal(result.code, 0);
  assert.equal((await getHealth(daemon.port)).ok, true);
});
