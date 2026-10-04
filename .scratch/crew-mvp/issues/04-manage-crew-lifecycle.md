# 04: Manage crew lifecycle without duplicate executions

**What to build:** A human can repeat crew startup, stop agents, and restart the coordinator without duplicating healthy executions or losing their stable identities and records.

**Blocked by:** 03: Launch and discover a complete crew (including manual acceptance).

**Status:** ready-for-agent

- [ ] Repeated startup with matching effective configuration reuses confirmed healthy executions and can complete missing launches after a known launch failure.
- [ ] Changed configuration is reported without silently replacing active agents.
- [ ] Crew shutdown stops only that crew's managed executions while retaining crew, seat, and execution history.
- [ ] Daemon shutdown leaves agent terminals running. Restart reconciles stored execution references with observed processes and reconnects to confirmed surviving agents.
- [ ] Missing or mismatched processes are reported honestly and are not silently treated as ready or replaced when execution state is unexplained.
- [ ] A fresh execution receives a new generation and credentials; old credentials cannot impersonate the current occupant. A daemon restart alone does not change the generation.
- [ ] CLI and direct HTTP tests cover reuse, shutdown, partial-launch continuation, reconciliation, and stale authorization.

## Manual validation

- [ ] Repeat startup and confirm unchanged execution identities and no extra tmux panes; alter configuration and verify explicit mismatch reporting.
- [ ] Stop and restart the daemon while agents remain alive; verify their terminals, identities, and generations are preserved.
- [ ] Stop the crew, inspect retained records, and relaunch fresh executions; verify new execution identities and rejection of stale credentials.

## Completion gate

Present exact commands and expected observations after automated checks pass. Stop for explicit manual acceptance before proceeding. No manual acceptance has been recorded.
