// Node's test runner isolates each test file in a process. Clear inherited settings before imports and subprocesses.
for (const name of Object.keys(process.env)) {
  if (/^(CODEX_PERMIT|PI_)/.test(name)) delete process.env[name];
}
