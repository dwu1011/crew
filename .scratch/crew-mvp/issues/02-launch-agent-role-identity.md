# 02: Launch one agent with role and identity

**What to build:** A human can start a configured Claude Code seat in tmux, observe its role and project context, and verify its managed identity from inside the execution.

**Blocked by:** 01: Start and stop the local daemon (including manual acceptance).

**Status:** awaiting-manual-validation

- [x] Crew startup reads YAML, resolves relative references against configuration location, and validates role sources and working directories before creating agent processes.
- [x] Invalid configuration creates no agent process and reports actionable errors.
- [x] A valid single-seat crew creates stable crew/seat records and an execution with a generation, scoped credentials, and a tmux reference.
- [x] The selected native runtime receives role instructions, project guidance, identity, and coordination instructions without overwriting existing project guidance.
- [x] The identity command resolves the caller through its managed credentials. Arbitrary identity claims do not establish authorization.
- [x] Status distinguishes launching, ready, and failed execution. Newly created processes are cleaned up if registration fails.
- [x] CLI and direct HTTP tests verify identity, validation, and startup outcomes; include a real-tmux integration check and an opt-in native-runtime smoke check.

## Manual validation

- [ ] Launch a one-seat crew and attach to its tmux terminal; confirm the intended runtime and working directory.
- [ ] Run the identity command inside the managed execution and verify its crew, seat, execution, and generation.
- [ ] Inspect supplied guidance and ask the agent to describe its role; verify that existing project instructions remain intact.
- [ ] Try configuration with a missing role source or working directory and verify that no extra agent is launched.

## Completion gate

Provide exact manual steps and expected outcomes after automated checks pass. Stop and wait for explicit user sign-off before another ticket starts. No manual acceptance has been recorded.


## Implementation handoff

Automated checks: `bun run typecheck` and `bun run test` pass: 18 tests passed, one opt-in native smoke check skipped. Standards and spec reviews have no outstanding findings after bounding tmux cleanup and verifying the timeout failure path. Deterministic tests use a native-runtime substitute inside real tmux; the native Claude smoke check is opt-in and requires an authenticated, trusted project. `ready` confirms the native SessionStart identity; it does not promise that the agent is idle or safe to receive terminal input.

Run from the crew repository:

```sh
bun run build
export CREW_HOME="$(mktemp -d /tmp/crew-manual-2.XXXXXX)"
node dist/cli.js up examples/single-seat/crew.yaml --json
node dist/cli.js status --crew demo --json
```

Attach using the returned `tmux.socket` and `tmux.session`:

```sh
tmux -S "$CREW_HOME/tmux.sock" attach-session -t <returned-session>
```

Complete Claude's normal login/trust prompts if shown. Ask it to run `crew whoami --json`, show its working directory, and explain its investigator role. Expected identity: crew `demo`, seat `investigator`, and nonempty crew/seat/execution/generation IDs. Inspect the returned `contextFile`; it contains the role, project guidance, and coordination instructions. Existing project instruction files must remain unchanged. Detach with Ctrl-b, d and check status again; native SessionStart should report `ready`.

Copy the example YAML alongside itself under a temporary filename and change `role_file` to a missing path, or add a nonexistent `cwd` under the seat. Running `up` on that copy must fail with a reference error and create no additional tmux session. Remove the temporary YAML afterward. Repeating a valid crew launch is intentionally deferred to ticket 4.

Optional native smoke check, with Claude already authenticated and this project trusted:

```sh
CREW_NATIVE_SMOKE=1 bun run test test/agent.test.ts -t 'native Claude'
```

Cleanup the exact returned session, then stop the daemon:

```sh
tmux -S "$CREW_HOME/tmux.sock" kill-session -t <returned-session>
node dist/cli.js daemon stop
```

Daemon shutdown leaves native terminals alone. Multi-seat launch, messaging, and lifecycle recovery are subsequent tickets. Manual checklist remains unchecked pending user validation; do not start ticket 3 yet.
