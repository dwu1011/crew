# 02: Launch one agent with role and identity

**What to build:** A human can start a configured Claude Code seat in tmux, observe its role and project context, and verify its managed identity from inside the execution.

**Blocked by:** 01: Start and stop the local daemon (including manual acceptance).

**Status:** ready-for-agent

- [ ] Crew startup reads YAML, resolves relative references against configuration location, and validates role sources and working directories before creating agent processes.
- [ ] Invalid configuration creates no agent process and reports actionable errors.
- [ ] A valid single-seat crew creates stable crew/seat records and an execution with a generation, scoped credentials, and a tmux reference.
- [ ] The selected native runtime receives role instructions, project guidance, identity, and coordination instructions without overwriting existing project guidance.
- [ ] The identity command resolves the caller through its managed credentials. Arbitrary identity claims do not establish authorization.
- [ ] Status distinguishes launching, ready, and failed execution. Newly created processes are cleaned up if registration fails.
- [ ] CLI and direct HTTP tests verify identity, validation, and startup outcomes; include a real-tmux integration check and an opt-in native-runtime smoke check.

## Manual validation

- [ ] Launch a one-seat crew and attach to its tmux terminal; confirm the intended runtime and working directory.
- [ ] Run the identity command inside the managed execution and verify its crew, seat, execution, and generation.
- [ ] Inspect supplied guidance and ask the agent to describe its role; verify that existing project instructions remain intact.
- [ ] Try configuration with a missing role source or working directory and verify that no extra agent is launched.

## Completion gate

Provide exact manual steps and expected outcomes after automated checks pass. Stop and wait for explicit user sign-off before another ticket starts. No manual acceptance has been recorded.
