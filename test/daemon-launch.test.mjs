import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveNodeBinary } from "../index.ts";

// Under Pi-Bolt, process.execPath is the agent binary. Launching the daemon with it started a new
// agent session per launch, and each session launched another.
test("the daemon never launches with a non-Node host binary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpg-node-"));
  const node = path.join(dir, "node"); fs.writeFileSync(node, ""); fs.chmodSync(node, 0o755);
  assert.equal(resolveNodeBinary("/usr/local/bin/node", ""), "/usr/local/bin/node");
  assert.equal(resolveNodeBinary("/Users/x/.pi-bolt/pi-bin", dir), node);
  assert.throws(() => resolveNodeBinary("/Users/x/.pi-bolt/pi-bin", ""), /not Node/);
});
