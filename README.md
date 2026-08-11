# pi-codex-permit-gate

A shared, fair concurrency gate for native OpenAI Codex requests in [Pi](https://github.com/badlogic/pi-mono).

When several Pi sessions call Codex at once, provider overloads can increase and a session with many subagents can crowd out other work. This extension places native `openai-codex` requests behind one local permit queue. It sends one request at a time by default and gives each top-level Pi session an equal turn, including all of its subagents.

## Install

Install the immutable release tag:

```bash
pi install git:github.com/longweekendprojects/pi-codex-permit-gate@v0.1.0
```

Then start a new Pi session or run `/reload` in an existing one. Inspect the live gate with:

```text
/codex-permit
```

The extension starts its local daemon on demand. Non-Codex providers bypass the gate.

## What it does

- Caps Codex concurrency across all local Pi processes.
- Schedules requests round-robin by top-level orchestration session.
- Treats a parent's Codex subagents as one scheduling group, so fanout does not buy extra turns.
- Exports the scheduling group from Claude and other non-Codex parents, allowing their native Codex children to join the same queue.
- Applies a bounded cooldown after Codex overload or rate-limit responses.
- Renews live permit leases and reclaims an abandoned lease after five minutes by default.
- Fails closed rather than sending an ungated Codex request when the daemon cannot grant a permit.
- Detects a degraded provider and backs off below the normal floor with escalating pauses until it recovers.
- Reports active requests, queued requests, wait times, groups, grants, throttles, expired permits, and incident state through `/codex-permit` and `GET /health`.

It does **not** proxy provider traffic, read credentials, or modify request payloads.

## How concurrency is chosen

Concurrency adapts between a floor and a ceiling rather than being fixed. The gate starts at three requests in flight, steps down after a provider overload or rate-limit response, and steps back up after a clean window.

The floor gives way during a provider outage. Sustained failures, several inside one window, put the gate in incident mode: the floor drops to one, pauses grow exponentially, and the climb back demands a longer quiet period. Holding a throughput floor against a failing provider produces neither completed work nor a recovering provider, and it makes the gate flap between two levels instead of settling.

The floor exists because serialization has a hard throughput ceiling. A queue that allows only one request in flight can never exceed one request per service time, so an eleven-second request caps the whole machine near five requests per minute regardless of how many sessions are waiting. Provider faults are retried and cost seconds; queue time is never recovered. An earlier release pinned concurrency to one to drive overload responses to zero, and it produced multi-minute queue waits under normal fanout. Optimize for completed work per minute, not for a zero error count.

This is pacing, not an availability guarantee. Isolated provider failures occur at any concurrency and recover after cooldown and retry.

## Configuration

Environment variables are read when Pi loads the extension or when the daemon first starts.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `CODEX_PERMIT_GATE_DISABLE` | `0` | Set to `1` to bypass the extension for a Pi process. |
| `CODEX_PERMIT_GATE_PORT` | `8795` | Local daemon port. All participating sessions must use the same value. |
| `CODEX_PERMIT_GATE_MIN` | `2` | Throughput floor for isolated failures. Sustained failure overrides it. |
| `CODEX_PERMIT_GATE_ABSOLUTE_MIN` | `1` | Floor during an incident. Never above `MIN`. |
| `CODEX_PERMIT_GATE_INCIDENT_THRESHOLD` | `3` | Failures inside one window that mark the provider degraded. |
| `CODEX_PERMIT_GATE_INCIDENT_WINDOW_MS` | `120000` | Window over which failures are counted. |
| `CODEX_PERMIT_GATE_INCIDENT_MAX_COOLDOWN_MS` | `60000` | Cooldown ceiling while an incident is active. |
| `CODEX_PERMIT_GATE_INCIDENT_RECOVERY_FACTOR` | `3` | Multiplier on the quiet period required to climb back during an incident. |
| `CODEX_PERMIT_GATE_MAX` | `6` | Ceiling the gate may climb to during clean windows. |
| `CODEX_PERMIT_GATE_START` | `3` | Initial concurrency, bounded by min and max. |
| `CODEX_PERMIT_GATE_OVERLOADED_COOLDOWN_MS` | `8000` | Cooldown requested after an overload response. |
| `CODEX_PERMIT_GATE_RATE_LIMIT_COOLDOWN_MS` | `10000` | Cooldown requested after a rate-limit response. |
| `CODEX_PERMIT_GATE_MAX_COOLDOWN_MS` | `15000` | Hard ceiling for any cooldown. A cooldown pauses every lane. |
| `CODEX_PERMIT_GATE_INCREASE_AFTER_MS` | `60000` | Clean window before stepping concurrency back up toward the ceiling. |
| `CODEX_PERMIT_GATE_PERMIT_TTL_MS` | `300000` | Time without a lease renewal before an abandoned permit is reclaimed. Set to `0` to disable. |
| `CODEX_PERMIT_GATE_ACQUIRE_WARNING_ATTEMPTS` | `600` | Unsuccessful attempts before reporting prolonged gate unavailability. The request remains blocked and retries continue. |
| `CODEX_PERMIT_GATE_ACQUIRE_RETRY_MS` | `500` | Delay between unsuccessful permit attempts. |
| `CODEX_PERMIT_GATE_VERBOSE` | `0` | Set to `1` for permit-grant notifications. |

After changing daemon settings, stop the existing daemon gracefully; the next Codex request restarts it:

```bash
pkill -TERM -f 'codex-permit-gate/permit-daemon.mjs'
```

## How fairness works

The daemon keeps one FIFO queue per orchestration root and rotates among non-empty roots. A root with eight Codex children therefore receives one turn per round, just like a root with one direct request. Leaf session IDs remain visible in health output for diagnosis.

A child inherits `CODEX_PERMIT_GATE_GROUP` only when Pi Subagents marks the process with `PI_SUBAGENT_CHILD=1`. An unrelated top-level process ignores a stale inherited group and uses its own session ID.

The daemon listens only on `127.0.0.1`. Its state and log live under `~/.pi/agent/codex-permit-gate/`.

## Limitations and security

- The gate covers Pi's native `openai-codex` provider only.
- Throughput is bounded by concurrency times service time. Sustained demand above that rate still queues, and long requests still make other sessions wait.
- Daemon settings are read once, when the daemon starts. Because any session can restart a stopped daemon, per-shell environment overrides are unreliable; change the defaults or set the variables for every session that might spawn it.
- The localhost control plane is unauthenticated. Any process running as the local user can acquire or renew permits, request cooldowns, or occupy the configured port. Renewable leases bound abandoned permits, but they do not defend against a malicious local process.
- If the gate remains unavailable, the hook stays pending and continues retrying instead of bypassing the concurrency limit. Esc cannot cancel a turn while it is waiting inside this hook. Free the configured port, restore the daemon, or restart Pi with `CODEX_PERMIT_GATE_DISABLE=1` to recover.
- The extension reduces overload pressure; it cannot prevent provider-side failures.
- Every Pi process that should participate must load the extension and use the same port.

## Operations

Raw health is available locally:

```bash
curl http://127.0.0.1:8795/health
```

The daemon log is:

```text
~/.pi/agent/codex-permit-gate/permit-daemon.log
```

Update by installing a newer immutable tag. Remove the package with:

```bash
pi remove git:github.com/longweekendprojects/pi-codex-permit-gate@v0.1.0
```

Then run `/reload` or restart Pi.

## Development

Requires Node.js 22 or newer.

```bash
npm test
```

The tests use isolated non-default ports and temporary home directories. They cover concurrency, group fairness, cooldowns, renewable and abandoned leases, fail-closed pending and recovery behavior, graceful shutdown, single-instance behavior, health diagnostics, and the subagent group-inheritance guard.

## License

MIT
