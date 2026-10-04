# 04: Manage crew lifecycle without duplicate executions

**What to build:** A human can repeat crew startup, stop agents, and restart the coordinator without duplicating healthy executions or losing their stable identities and records.

**Blocked by:** 03: Launch and discover a complete crew (including manual acceptance).

**Status:** awaiting-manual-validation

- [x] Repeated startup with matching effective configuration reuses confirmed healthy executions and can complete missing launches after a known launch failure.
- [x] Changed configuration is reported without silently replacing active agents.
- [x] Crew shutdown stops only that crew's managed executions while retaining crew, seat, and execution history.
- [x] Daemon shutdown leaves agent terminals running. Restart reconciles stored execution references with observed processes and reconnects to confirmed surviving agents.
- [x] Missing or mismatched processes are reported honestly and are not silently treated as ready or replaced when execution state is unexplained.
- [x] A fresh execution receives a new generation and credentials; old credentials cannot impersonate the current occupant. A daemon restart alone does not change the generation.
- [x] CLI and direct HTTP tests cover reuse, shutdown, partial-launch continuation, reconciliation, and stale authorization.

## Manual validation

- [ ] Repeat startup and confirm unchanged execution identities and no extra tmux panes; alter configuration and verify explicit mismatch reporting.
- [ ] Stop and restart the daemon while agents remain alive; verify their terminals, identities, and generations are preserved.
- [ ] Stop the crew, inspect retained records, and relaunch fresh executions; verify new execution identities and rejection of stale credentials.

## Completion gate

Present exact commands and expected observations after automated checks pass. Stop for explicit manual acceptance before proceeding. No manual acceptance has been recorded.


## Manual handoff

Use a fresh state directory. Earlier executions without process identity receipts are reported as unverified and are not silently adopted. From the crew repository:

```sh
bun run build
export CREW_HOME="$(mktemp -d /tmp/crew-manual-4.XXXXXX)"
bun run crew up examples/three-seat/crew.yaml --json
bun run crew attach --crew demo-crew
```

Complete native login/trust prompts if required. Detach the overview with Ctrl-a then d. Check status, then repeat startup:

```sh
bun run crew status --crew demo-crew --json
bun run crew up examples/three-seat/crew.yaml --json
```

Expected: healthy seats retain crew/seat/execution IDs, generations, and tmux references. No additional native sessions appear. If a seat is still launching, it remains launching and is not duplicated. Changing a role file or effective configuration must produce a mismatch instead of replacing agents; restore that file afterward before further startup checks.

Coordinator restart:

```sh
bun run crew daemon stop
bun run crew daemon start
bun run crew status --crew demo-crew --json
bun run crew attach --crew demo-crew
```

Expected: Claude terminals survive, identity and generation stay unchanged, and confirmed native processes reconnect as ready. Detach with Ctrl-a then d. Ask any managed agent to run `crew whoami --json`; its credential remains valid after daemon restart.

Crew shutdown and fresh launch:

```sh
bun run crew down --crew demo-crew --json
bun run crew status --crew demo-crew --json
bun run crew up examples/three-seat/crew.yaml --json
bun run crew status --crew demo-crew --json
```

Expected: down stops only this crew's agents and retains history. Relaunch keeps stable crew/seat IDs while creating new execution IDs, generations, native sessions, and credentials. History includes previous executions, their native launch outcome, and failure reasons. Old credentials are rejected; restart alone does not change credentials. A managed seat cannot call the operator-only down endpoint.

Optional controlled partial-launch continuation: use ticket 3's startup-fault wrapper in fresh state, allow coder to fail, then edit the wrapper to remove its deliberate exit. Repeat `up` with unchanged crew YAML. Planner/reviewer retain execution identities; only the failed coder gets a fresh execution. Roles/configuration must remain unchanged. An unexpected native exit after readiness is reported as unknown and requires explicit down before replacement.

Missing/mismatched process checks are automated with real tmux. A missing terminal is reported as unknown and is not silently recreated by up. Down may mark a conclusively absent execution stopped, enabling a requested fresh launch. A terminal whose observed owner differs from the recorded runner is not killed; down reports an unverified-execution error. Inspect and stop such terminals manually rather than asking the daemon to guess ownership. An unresponsive tmux server also remains unverified.

Cleanup:

```sh
bun run crew down --crew demo-crew
bun run crew daemon stop
```

Unlike detach or daemon stop, `crew down` terminates native agents. Manual acceptance is pending. Do not start ticket 5 without user sign-off.
