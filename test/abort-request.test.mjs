import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { postJson } from "../index.ts";

// A cancelled permit wait destroyed the request with an error, which could escape as an uncaught
// exception and take down the whole agent process.
test("a cancelled permit request rejects instead of crashing the process", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-abort-"));
  const agent = path.join(home, "agent");
  fs.mkdirSync(agent);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [key, value] of Object.entries({ HOME: home, PI_CODING_AGENT_DIR: agent })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const scratchToken = path.join(agent, "codex-permit-gate", "local-token");
  const tokenReads = [];
  const openSync = fs.openSync;
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (typeof file === "string" && path.basename(file) === "local-token") {
      tokenReads.push(file === scratchToken);
      if (file !== scratchToken) throw new Error("test token read outside scratch");
    }
    return openSync(file, ...args);
  });
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    const before = new AbortController(); before.abort();
    await assert.rejects(postJson(9, "/acquire", {}, 1000, before.signal), { name: "AbortError" });
    const server = net.createServer(() => {}).listen(0, "127.0.0.1");
    t.after(() => { if (server.listening) server.close(); });
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address();
    assert.ok(port < 8790 || port > 8797, "tests must not use a live daemon port");
    const during = new AbortController();
    const pending = postJson(port, "/acquire", {}, 10_000, during.signal);
    setTimeout(() => during.abort(), 50);
    await assert.rejects(pending, { name: "AbortError" });
    server.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(uncaught, []);
    assert.deepEqual(tokenReads, [true], "only the scratch token path may be read");
  } finally { process.off("uncaughtException", onUncaught); }
});
