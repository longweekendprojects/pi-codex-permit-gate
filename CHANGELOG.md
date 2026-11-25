# Changelog

## 0.5.4 - 2026-11-24

- Reject unexpected Host and Origin headers on local requests and require JSON on control POSTs.
- Let operators require a local token after upgrading daemons and reloading clients.
- Block Codex requests when a provider-port map is empty or repeats a provider, and report the bad entry.
- Report why a local permit request was refused without interrupting its wait.
- Count local admission rejections and control POSTs without a valid token in `/health`.
- Write rate-limited rejection messages and token creation failures to the daemon log.
