# Crew architecture

Reviewed: 2026-10-06. This describes the working tree, including uncommitted profile and project-run changes. See the [validation record](docs/exec-plans/active/project-runs.md) for verification limits.

Crew exposes a CLI backed by a local HTTP daemon. The daemon records coordination state in SQLite and manages Claude Code executions through tmux. See [domain vocabulary](CONTEXT.md) and [product scope](docs/product-specs/index.md).

## Code map

| Responsibility | Files |
| --- | --- |
| Command parsing and daemon requests | [cli.ts](src/cli.ts), [client.ts](src/client.ts) |
| Daemon lifecycle and discovery | [lifecycle.ts](src/lifecycle.ts), [state.ts](src/state.ts) |
| HTTP request handling and startup | [daemon.ts](src/daemon.ts) |
| Persistent schema and migrations | [database.ts](src/database.ts) |
| Configuration validation | [config.ts](src/config.ts) |
| Crew launch, roster, identity, and shutdown | [crews.ts](src/crews.ts) |
| Managed process verification and input | [managed-executions.ts](src/managed-executions.ts), [process-identity.ts](src/process-identity.ts) |
| Native execution and hooks | [agent-runner.ts](src/agent-runner.ts) |
| tmux and Claude input observation | [terminal.ts](src/terminal.ts), [claude-input.ts](src/claude-input.ts) |
| Message persistence, replies, and delivery | [messages.ts](src/messages.ts), [delivery-attempts.ts](src/delivery-attempts.ts) |
| Reusable profiles, project selection, and bundled planning roles | [profiles.ts](src/profiles.ts), [planning.ts](src/planning.ts) |

## Storage

The daemon state directory defaults to `~/.crew`; `CREW_HOME` or `--state-dir` selects another directory. It contains `crew.sqlite`, daemon discovery and runtime files, and private execution files under `executions/<execution-id>/`.

SQLite records crews, stable seats, execution generations, messages, delivery attempts, and supporting lifecycle and input evidence. Schema changes are tracked by migrations in `database.ts`. Runtime state is separate from the Git-versioned [knowledge base](docs/index.md).

Profile registrations store a stable identity and canonical definition source. The bundled planning roles ship in the compiled program. A unique profile/project association identifies each project run. Executions capture their effective role and project; retired seats preserve history without appearing in the current roster.

## Main flows

1. **Launch:** the CLI requests startup; the daemon validates configuration and project guidance, records identity, and launches managed seats in tmux. Root `CLAUDE.md` and `AGENTS.md`, role instructions, identity, roster, and coordination guidance are assembled into a private execution context file.
2. **Send:** the daemon persists a message and initial delivery attempt before terminal submission. The delivery worker checks execution ownership and input safety before submitting an envelope.
3. **Receive and reply:** native prompt evidence establishes submission. An explicit acknowledgment or linked reply records receipt; a reply acknowledges its original message transactionally.
4. **Conversation reset:** authenticated clear/resume hooks update the current conversation ID after process ownership and cwd checks. Launch identity stays immutable; readiness markers and delivery guards must match the current conversation.
5. **Recover:** daemon restart reconciles surviving executions, resumes eligible pending deliveries, and treats interrupted submissions as uncertain. Retrying uncertain delivery requires explicit duplicate acceptance.

The daemon listens on loopback. Operator and execution credentials have different scopes. Stopping the daemon leaves agent terminals running; stopping a crew terminates its managed executions and then clears its messages, delivery attempts, and submission artifacts while retaining execution history. Operator-only message clearing uses the same crew serialization as terminal input, preventing queued deliveries from injecting deleted messages.

Profile launches bind to an existing canonical project directory. Human commands use the most specific containing project root unless `--crew` overrides selection; multiple profiles require a choice. Managed commands derive their crew from their credential and reject conflicting selectors. HTTP requests without new selectors retain the legacy selection contract.

## Verification

[Daemon tests](test/daemon.test.ts) and [agent tests](test/agent.test.ts) exercise CLI and HTTP behavior with isolated state. Controlled native fixtures support deterministic launch and delivery checks. Real-agent checks are opt-in; historical results live in the [MVP ticket records](docs/exec-plans/completed/crew-mvp/index.md).
