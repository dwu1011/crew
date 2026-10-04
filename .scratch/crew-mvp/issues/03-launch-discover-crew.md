# 03: Launch and discover a complete crew

**What to build:** A human can launch multiple named seats, and each agent can discover teammates, their roles, and execution status within the correct crew.

**Blocked by:** 02: Launch one agent with role and identity (including manual acceptance).

**Status:** awaiting-manual-validation

- [x] A multi-seat configuration launches each supported seat with its own role, identity, execution, and tmux terminal.
- [x] Agents receive the teammate roster and can query members and roles through the CLI and HTTP interface.
- [x] Managed callers derive crew selection from their identity. Human callers must select a crew when more than one makes the operation ambiguous.
- [x] Crew status displays per-seat launch outcomes and does not report overall readiness when a required seat failed.
- [x] Partial launch failure cleans up unregistered processes while accurately reporting successfully registered seats.
- [x] Unsupported runtimes and duplicate seat names are rejected during validation.
- [x] CLI and direct HTTP tests cover crew scope, membership, multi-seat launch, and partial failures.

## Manual validation

- [ ] Launch planner, coder, and reviewer seats; inspect each terminal and verify distinct identities and role guidance.
- [ ] Query members from a managed seat and from a human shell; verify the same roster and role information.
- [ ] Exercise ambiguous crew selection and a controlled partial launch failure; verify explicit errors and accurate per-seat status.

## Completion gate

Supply runnable manual steps and expected outcomes after automated checks pass. Stop until the user explicitly accepts this ticket, even if an independent ticket could otherwise start. No manual acceptance has been recorded.


## Manual handoff

Automated verification: `bun run typecheck` passes; `bun run test` passes 26 tests with one opt-in native smoke check skipped. Standards and spec reviews against `83d8897` have no outstanding findings. Deterministic launch checks use a native-runtime substitute in real tmux; actual native multi-seat validation remains manual.

Use a fresh state directory so an older daemon does not run the previous binary. From the crew repository:

```sh
bun run build
export CREW_HOME="$(mktemp -d /tmp/crew-manual-3.XXXXXX)"
node dist/cli.js up examples/three-seat/crew.yaml --json
node dist/cli.js members --crew demo-crew --json
node dist/cli.js status --crew demo-crew --json
```

Expected: planner, coder, and reviewer, each with distinct seat, execution, generation, native-session, and tmux-session identities. Members includes role text and execution status. `ready` means the native startup hook confirmed that execution, not that it is idle. Login/trust prompts may keep a seat launching until completed.

Attach to each returned session using the returned socket and session name. For example:

```sh
tmux -S "$CREW_HOME/tmux.sock" list-sessions
tmux -S "$CREW_HOME/tmux.sock" attach-session -t "<actual-session-name>"
```

Ask each native agent to run `crew whoami --json`, `crew members --json`, and `crew status --json`, then describe its own role and its teammates. Expect all three to report the same crew roster, each with its own identity and role. These commands derive crew selection from the managed credential. Asking a managed seat to run `crew members --crew different --json` must fail; naming another crew cannot change its scope. Inspect `contextFile` from status to see the initial role, roster, and coordination instructions. Messaging remains unimplemented.

For a second human-selectable crew, create a sibling configuration:

```sh
sed 's/name: demo-crew/name: demo-other/' examples/three-seat/crew.yaml > examples/three-seat/manual-other.yaml
node dist/cli.js up examples/three-seat/manual-other.yaml --json
node dist/cli.js members --json
node dist/cli.js status --json
node dist/cli.js members --crew demo-other --json
rm examples/three-seat/manual-other.yaml
```

The commands without `--crew` must report ambiguity; explicit selection succeeds. A human may omit selection when only one crew exists. Managed agents always use their own crew regardless of how many exist.

Controlled native startup failure, in another fresh state directory (does not replace the healthy test crew):

```sh
export CREW_PARTIAL_HOME="$(mktemp -d /tmp/crew-partial-3.XXXXXX)"
export CREW_NATIVE_BIN="$(command -v claude)"
cat > "$CREW_PARTIAL_HOME/claude-fault" <<'SH'
#!/bin/sh
if [ "${CREW_SEAT:-}" = coder ]; then
  echo 'Intentional coder startup failure' >&2
  exit 11
fi
exec "$CREW_NATIVE_BIN" "$@"
SH
chmod 700 "$CREW_PARTIAL_HOME/claude-fault"
CREW_CLAUDE_BIN="$CREW_PARTIAL_HOME/claude-fault" node dist/cli.js --state-dir "$CREW_PARTIAL_HOME" up examples/three-seat/crew.yaml --json
node dist/cli.js --state-dir "$CREW_PARTIAL_HOME" status --crew demo-crew --json
```

Complete planner/reviewer login and trust prompts if needed. Expected: coder becomes `failed` with an exit-11 reason, planner/reviewer remain independently `launching` or `ready`, and overall crew status is `failed`. Native startup failure is asynchronous: the initial `up` result can still show launching; poll status afterward. The automated tmux fault check separately covers failure after terminal creation, verifying cleanup of the failed terminal and survival of registered teammates.

Direct HTTP discovery uses authenticated `GET /members?crew=<name>` and `GET /crews?crew=<name>`. Operator credentials require selection when ambiguous; execution credentials resolve their own crew and reject cross-crew selection with 403. Invalid credentials return 401. The previous operator-only `GET /crews/<name>` status route is retained.

Clean up both private test servers, then their daemons. This is safe for these newly created test directories and does not touch Herdr's tmux socket:

```sh
tmux -S "$CREW_HOME/tmux.sock" kill-server
node dist/cli.js daemon stop
tmux -S "$CREW_PARTIAL_HOME/tmux.sock" kill-server
node dist/cli.js --state-dir "$CREW_PARTIAL_HOME" daemon stop
```

Daemon stop alone intentionally leaves Claude terminals running. Keep the manual checklist unchecked until the user supplies results. Do not start ticket 4 without user acceptance.
