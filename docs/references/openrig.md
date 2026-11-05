# OpenRig

Status: source-backed reference notes. Updated: 2026-10-08. These notes describe the inspected checkout, not a guarantee about newer releases.

## Sources and provenance

- Website: [openrig.dev](https://openrig.dev/).
- Repository: [mvschwarz/openrig](https://github.com/mvschwarz/openrig).
- Inspected commit: `5d7d741b0e93fd85452f0526d9393ebd48f3c932`.
- The project/context research used this checkout; its identity and the supporting files were rechecked when documenting these notes on 2026-10-08. The original research date was not retained. OpenRig's full test suite was not executed during this research.
- This records ideas and observed behavior. It does not establish that upstream source code was copied into Crew.

| Area | Pinned upstream evidence |
| --- | --- |
| Architecture and storage | [Architecture](https://github.com/mvschwarz/openrig/blob/5d7d741b0e93fd85452f0526d9393ebd48f3c932/ARCHITECTURE.md) |
| Terminology and reusable blueprints | [README concepts](https://github.com/mvschwarz/openrig/blob/5d7d741b0e93fd85452f0526d9393ebd48f3c932/README.md#key-concepts) |
| Launch directory and library resolution | [CLI up command](https://github.com/mvschwarz/openrig/blob/5d7d741b0e93fd85452f0526d9393ebd48f3c932/packages/cli/src/commands/up.ts) |
| Project catalog, context, and skill projection | [Project workspace contract](https://github.com/mvschwarz/openrig/blob/5d7d741b0e93fd85452f0526d9393ebd48f3c932/docs/reference/project-workspace.md) |
| Message submission and input readiness | [Session transport](https://github.com/mvschwarz/openrig/blob/5d7d741b0e93fd85452f0526d9393ebd48f3c932/packages/daemon/src/domain/session-transport.ts), [transport routes](https://github.com/mvschwarz/openrig/blob/5d7d741b0e93fd85452f0526d9393ebd48f3c932/packages/daemon/src/routes/transport.ts) |
| Work ownership and handoff state | [Queue schema](https://github.com/mvschwarz/openrig/blob/5d7d741b0e93fd85452f0526d9393ebd48f3c932/packages/daemon/src/db/migrations/024_queue_items.ts) |
| Workflow execution and limitations | [Workflow runtime](https://github.com/mvschwarz/openrig/blob/5d7d741b0e93fd85452f0526d9393ebd48f3c932/docs/as-built/architecture/workflow-runtime.md) |

## Core mental model

OpenRig coordinates native agent processes through a daemon, runtime adapters, terminal surfaces, and durable coordination state. The CLI generally calls daemon HTTP routes. SQLite records coordination; tmux hosts or exposes interactive processes. The database is not the model's context window, and agents need not read SQLite directly to communicate.

A reusable AgentSpec describes an agent blueprint: guidance, skills, hooks, profiles, and startup contracts. A RigSpec describes the arrangement of seats, including grouping, relationships, and continuity policy. A seat is a stable role and address; the particular conversation occupying it can change. A pod groups related seats and shared context without giving those agents one shared model context window.

Keep authored definitions separate from running sessions. Reusing a blueprint does not imply reusing the same conversation, and selecting another project does not automatically replace the context of an already running agent.

## How agents receive context

The useful decomposition from our discussion is:

| Context | Purpose |
| --- | --- |
| Role | Responsibilities, expected behavior, and division of work. |
| Project | Goal, architecture, conventions, source files, and project guidance. |
| Current task | The specific request, constraints, acceptance criteria, and evidence required. |
| Coordination | Seat identity, teammate addresses, available commands, and handoff conventions. |
| Continuity | Prior work, outstanding decisions, checkpoints, and recoverable session state. |

These are conceptual inputs, not a claim that upstream has five identically named fields. Runtime adapters and context/skill installation provide the authored guidance; requests and queue/workflow state provide work context. Native conversation storage and recovery mechanisms provide continuity.

A harness is the runtime environment that starts and supports the agent, including its configuration, projected guidance, skills, and hooks. It is broader than a project CLAUDE.md file. Project context and role context can be composed into that environment independently.

Continuity can improve future behavior by preserving useful experience. It does not by itself train model weights or prove that an agent learned a generalizable skill. Remembering a past decision, resuming a conversation, and changing model parameters are different mechanisms.

## Messaging, tasks, and workflows

Sending text to an agent is a daemon-mediated transport operation. The inspected transport resolves the recipient, considers native activity and terminal readiness, and submits an envelope through the terminal adapter. Runtime hooks, process observations, and screen inspection contribute evidence about whether input is safe. This is more than blindly typing text into an arbitrary pane; it also does not make terminal submission equivalent to task completion.

Messages communicate. Queue items track owned work and its state, provenance, handoff, blocking information, and closure obligations. Workflow instances track a structured process and progression through steps. These are distinct concepts even when a message announces a new task or a handoff.

Agent-directed coordination lets an agent decide whom to consult or hand work to as new information appears. It is useful for investigation, design review, and unfamiliar problems whose next step is not known in advance. Workflow-directed coordination encodes more of the permitted progression, routing, and gates; it suits repeated processes with explicit verification and release obligations. They can coexist.

A task's objective may remain stable while its owner changes or teammates provide information. That is a useful abstraction, not a guarantee that every handoff preserves one row unchanged. Work can split, produce follow-up tasks, or change scope. A planner-first route is a chosen topology or workflow, not a universal OpenRig rule.

The inspected workflow runtime supports explicit exits and durable step/frontier state. Its documentation also distinguishes enforced behavior from declarations that only produce advisories. Do not infer enforcement from the presence of a YAML field alone.

## What SQLite stores

These are selected responsibilities, not a complete current schema inventory. Later migrations extend the initial tables.

| Records | Responsibility and evidence |
| --- | --- |
| `rigs`, `nodes`, `edges` | Topology, logical seats, and their relationships; [core schema](https://github.com/mvschwarz/openrig/blob/5d7d741b0e93fd85452f0526d9393ebd48f3c932/packages/daemon/src/db/migrations/001_core_schema.ts). |
| `bindings`, `sessions` | Physical terminal bindings and harness session state; [binding/session schema](https://github.com/mvschwarz/openrig/blob/5d7d741b0e93fd85452f0526d9393ebd48f3c932/packages/daemon/src/db/migrations/002_bindings_sessions.ts). |
| Events, snapshots, checkpoints, chat records | Coordination history and recovery support; see the migration sequence and architecture. These do not imply a complete copy of the model's memory. |
| `queue_items` and queue transitions | Owned work, state changes, handoffs, blocking, and closure obligations; queue schema above. |
| Workflow specifications, instances, and step trails | Parsed process definitions, execution/frontier state, and progression history; workflow runtime above. |

Authored project documents remain files. A durable coordination database, a Git-versioned project workspace, and a native model conversation serve different purposes.

## Reusing roles across projects

The inspected CLI supports a launch-only working-directory override:

```sh
rig up starter --cwd .
```

Some built-in launch paths also default to the caller's current directory. This is a launch decision, not live context switching when the human later changes folders. `--target` serves bundle installation/materialization and is distinct from a runtime working-directory override.

Project metadata can live outside the code working directory. The workspace catalog associates project IDs, roots, and optionally rig names. The documented work-install selection order is: explicit project; the only declared project; the calling rig's association; the deepest containing project root; the only unclaimed project; otherwise an explicit-choice error. Ties and conflicting associations require a choice.

Project context selectors and skill identities are authored inputs. Runtime-specific skill directories and ownership receipts are generated projections. Seats sharing a runtime and working directory can contribute to a combined skill projection. A changed projection does not establish that a running harness hot-reloaded it.

OpenRig also guards already-running rig identity during launch. Reusing a definition concurrently is not permission to overwrite an existing run with the same identity. Our recommendation to reuse planning roles in separate project runs is a Crew design choice, rather than a claim that OpenRig requires every project to own a wholly separate authored role definition.

## Illustrative flow

This example explains the concepts; it is not a claim about a built-in OpenRig topology.

1. Define planner, implementer, and reviewer roles and their seats in a reusable topology.
2. Launch it against a selected project. The daemon validates inputs, starts native agents through adapters, and associates logical seats with sessions and terminal bindings.
3. Give planner a concrete goal and acceptance criteria. Planner requests implementation or clarification through the coordination interface.
4. Track owned work in the queue. The implementer may consult another seat, report a blocker, or hand off review without treating every chat response as completed work.
5. If a workflow is used, its routing and exits govern progression and evidence obligations. Otherwise agents and the operator coordinate the next action explicitly.
6. Inspect durable records and native session state during recovery. Preserve the distinction between resuming an existing conversation and starting a fresh occupant with supplied continuity context.

## What Crew adopted and changed

| OpenRig-inspired idea | Crew choice |
| --- | --- |
| Native interactive agents with stable role addresses | Named seats and distinct execution generations. |
| Daemon-mediated coordination and durable state | A local CLI/HTTP daemon and SQLite messages with inspectable delivery attempts. |
| Terminal messaging with readiness evidence | Guarded input, protected prompt intents, and native prompt receipts; uncertain delivery requires explicit duplicate acceptance. |
| Reusable authored roles plus project selection | Global profiles bound to canonical project folders, with separate executions and history per project run. |
| Lifecycle and launch/delivery testing | Public CLI and direct daemon HTTP acceptance seams with real SQLite/tmux and controlled fixtures. |

Crew deliberately keeps the current scope smaller: one native agent runtime, no project catalog or bundle marketplace, and no OpenRig-scale task queue, workflow, proof, or snapshot/restore subsystem. Crew's exact message persistence, receipt, retry, authorization, and normalization contracts are its own implementation decisions. These notes do not assert that OpenRig uses Crew's attempt marker, database schema, or prompt-hook comparison.

See the [MVP spec](../../crew-mvp-spec.md), [profile/project-run spec](../../crew-project-runs-spec.md), [domain vocabulary](../../CONTEXT.md), [messaging design](../design-docs/durable-messaging.md), and [project-run validation record](../exec-plans/active/project-runs.md).
