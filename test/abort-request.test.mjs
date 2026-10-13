import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { postJson } from "../index.ts";

// A cancelled permit wait destroyed the request with an error, which could escape as an uncaught
// exception and take down the whole agent process.
test("a cancelled permit request rejects instead of crashing the process", async () => {
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    const before = new AbortController(); before.abort();
    await assert.rejects(postJson(9, "/acquire", {}, 1000, before.signal), { name: "AbortError" });
    const server = net.createServer(() => {}).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const during = new AbortController();
    const pending = postJson(server.address().port, "/acquire", {}, 10_000, during.signal);
    setTimeout(() => during.abort(), 50);
    await assert.rejects(pending, { name: "AbortError" });
    server.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(uncaught, []);
  } finally { process.off("uncaughtException", onUncaught); }
});
