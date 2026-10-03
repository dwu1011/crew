# 01: Start and stop the local daemon

**What to build:** A human can start, inspect, and stop one local coordinator through the crew CLI, with persistent state and an HTTP interface that subsequent features can use.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Daemon start, status, and stop work through the CLI and local HTTP interface, with clear output and exit behavior.
- [ ] The daemon listens only on loopback and initializes persistent SQLite storage with schema migration tracking.
- [ ] Repeated start succeeds for a healthy daemon without launching another instance. An unresponsive existing instance is reported rather than silently replaced.
- [ ] Stop shuts down the daemon cleanly and is safe to repeat. Agent terminals, when later supported, are not terminated by daemon stop.
- [ ] CLI and direct HTTP tests use isolated state, verify observable lifecycle behavior, and clean up launched processes.

## Manual validation

- [ ] Start the daemon, inspect its status, and verify the reported HTTP health response.
- [ ] Start it again and verify that the same instance remains active.
- [ ] Stop it, verify unreachable/stopped status, then start it again using the same persistent state.

## Completion gate

After automated checks pass, provide exact commands, prerequisites, and expected results for the manual checks above. Stop and wait for the user's explicit sign-off before implementing any other ticket. If validation fails, repair this ticket first. No manual acceptance has been recorded.
