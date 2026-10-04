# 03: Launch and discover a complete crew

**What to build:** A human can launch multiple named seats, and each agent can discover teammates, their roles, and execution status within the correct crew.

**Blocked by:** 02: Launch one agent with role and identity (including manual acceptance).

**Status:** ready-for-agent

- [ ] A multi-seat configuration launches each supported seat with its own role, identity, execution, and tmux terminal.
- [ ] Agents receive the teammate roster and can query members and roles through the CLI and HTTP interface.
- [ ] Managed callers derive crew selection from their identity. Human callers must select a crew when more than one makes the operation ambiguous.
- [ ] Crew status displays per-seat launch outcomes and does not report overall readiness when a required seat failed.
- [ ] Partial launch failure cleans up unregistered processes while accurately reporting successfully registered seats.
- [ ] Unsupported runtimes and duplicate seat names are rejected during validation.
- [ ] CLI and direct HTTP tests cover crew scope, membership, multi-seat launch, and partial failures.

## Manual validation

- [ ] Launch planner, coder, and reviewer seats; inspect each terminal and verify distinct identities and role guidance.
- [ ] Query members from a managed seat and from a human shell; verify the same roster and role information.
- [ ] Exercise ambiguous crew selection and a controlled partial launch failure; verify explicit errors and accurate per-seat status.

## Completion gate

Supply runnable manual steps and expected outcomes after automated checks pass. Stop until the user explicitly accepts this ticket, even if an independent ticket could otherwise start. No manual acceptance has been recorded.
