# Crew MVP: local agent crews with durable terminal messaging

Status: specification draft with an approved nine-ticket breakdown. The project workspace is crew; an external issue tracker is not configured. The user confirmed CLI acceptance testing plus direct daemon HTTP testing and requires manual validation after every ticket. `crew` is the working product and command name.

## Problem Statement

The user wants to run several native coding agents as a crew, give each agent a distinct role and project context, and let them communicate directly. Manually launching terminals, copying requests between agents, and tracking replies makes collaboration difficult to reproduce and inspect. Terminal input alone leaves no reliable record of messages that were missed, failed, or submitted just before a coordinator crash.

The MVP should preserve the familiar interactive agent experience while making crew identity and communication durable. It should provide the core collaboration mechanisms discussed in the conversation without adopting OpenRig's full workflow, task, proof, and recovery systems.

## Solution

Provide a local CLI and persistent daemon. A human defines a crew in YAML and starts it with one command. The daemon launches configured agents in tmux, supplies role and coordination context, and records stable seats separately from their current executions.

Agents communicate through the CLI. The daemon commits the full message and a pending delivery attempt to SQLite before injecting the full message into the recipient's terminal. Agents receive messages directly in their native conversation; they do not need to query SQLite or fetch every message from an inbox. Message history remains available through the CLI for inspection and recovery.

The CLI reports persistence, submission, and acknowledgment separately. Replies link to the original message and acknowledge it. Restarting the daemon preserves crew records and pending messages, reconnects to surviving managed executions, and flags interrupted submissions as uncertain instead of blindly duplicating them.

## User Stories

1. As a human operator, I want to define a crew in YAML, so that I can reproduce its membership and roles.
2. As a human operator, I want to select each seat's role instructions, so that agents know their responsibilities.
3. As a human operator, I want to configure a project location and working directories, so that agents operate on the intended files.
4. As a human operator, I want invalid configuration rejected before agents launch, so that mistakes do not create a partially configured crew.
5. As a human operator, I want one command to start the crew and its daemon, so that setup is straightforward.
6. As a human operator, I want repeated startup to reuse healthy executions, so that I do not accidentally launch duplicate agents.
7. As a human operator, I want changed configuration reported explicitly, so that startup does not silently replace running agents.
8. As a human operator, I want seat identity to remain stable across fresh executions, so that messages can address a role consistently.
9. As an agent, I want my seat and execution identity supplied at launch, so that coordination records identify the correct actor.
10. As an agent, I want role, project, and coordination guidance supplied at startup, so that I know how to participate.
11. As an agent, I want to inspect crew members and their roles, so that I can choose an appropriate recipient.
12. As an agent, I want to inspect my own identity, so that I can understand my execution context.
13. As an agent, I want to send a full message to another seat, so that I can request help or share findings.
14. As an agent, I want to send message content from a file or standard input, so that multiline content and shell-sensitive characters are preserved.
15. As a human operator, I want to send messages to a selected crew, so that I can direct its work.
16. As a sender, I want a durable message ID returned after persistence, so that I can inspect the result without repeating the send.
17. As a recipient, I want the full message delivered into my native terminal conversation, so that I do not need an extra retrieval operation.
18. As a recipient, I want sender identity, message ID, and reply instructions included, so that I can interpret and answer the message.
19. As a sender, I want messages saved before submission, so that a failed terminal operation does not lose the request.
20. As a sender, I want messages to stopped recipients to remain pending, so that delivery can occur when the seat becomes available.
21. As a recipient, I want delivery deferred during unsafe input conditions, so that a message does not answer a permission dialog or overwrite a draft.
22. As a recipient, I want concurrent messages submitted serially, so that their contents do not interleave.
23. As a sender, I want delivery attempts associated with the actual recipient execution, so that replacement agents do not inherit misleading delivery evidence.
24. As a recipient, I want to acknowledge a message explicitly, so that the sender can distinguish submission from receipt.
25. As a recipient, I want a reply to acknowledge its original message, so that normal conversation does not require a separate acknowledgment command.
26. As an agent, I want to inspect unacknowledged messages and full message history, so that I can recover missed context.
27. As an agent, I want reading a message to leave acknowledgment unchanged, so that inspection is not mistaken for acceptance of receipt.
28. As a human operator, I want to inspect message bodies, replies, and delivery attempts, so that I can diagnose communication failures.
29. As a human operator, I want definite failures distinguished from uncertain submissions, so that I can choose whether a retry is appropriate.
30. As a human operator, I want retrying uncertain delivery to require an explicit duplicate-acceptance flag, so that I do not accidentally resend work.
31. As a human operator, I want the daemon to reconnect to surviving managed agents after restart, so that coordination can resume without replacing them.
32. As a human operator, I want queued delivery to recover after restart, so that accepted messages are not forgotten.
33. As a human operator, I want daemon shutdown to leave agent terminals running, so that stopping coordination does not terminate work.
34. As a human operator, I want crew shutdown to stop managed agents while retaining records, so that I can inspect previous execution afterward.
35. As a human operator, I want to inspect execution health and unresolved delivery, so that I know which crews need attention.
36. As an integration author, I want machine-readable CLI output, so that agents and scripts can consume results without parsing prose.
37. As a human operator, I want to attach to agent terminals through tmux, so that I can observe and intervene directly.

## Implementation Decisions

- Domain vocabulary: a crew groups stable seats; a seat defines a role and runtime configuration; an execution is one launched occupant of a seat; a generation identifies that occupant; a message addresses a seat; a delivery attempt targets one execution. A daemon restart does not create a new agent generation.
- Use TypeScript and Node.js for execution, Bun for package management and development scripts, Commander for CLI parsing, Hono for local HTTP handling, better-sqlite3 for persistence, YAML with Zod validation for configuration, tmux for terminal execution, and Vitest for tests. Resolve supported dependency and runtime versions during implementation rather than pinning unverified versions in this spec.
- Begin with one runtime. Claude Code is the proposed first runtime; Codex support follows after the launch-and-message path is validated. Do not expose selectable runtimes that have not been implemented and tested.
- Keep the CLI thin. It parses input, reads the caller's managed credentials, submits daemon requests, and renders results. The daemon owns configuration validation, identity resolution, persistence, launch, recipient resolution, serialization, terminal delivery, acknowledgment, and recovery.
- Use a loopback-only daemon listener. Managed executions receive scoped credentials alongside their identity; a caller-supplied seat name alone is not proof of identity. Human callers are attributed as the operator rather than an agent seat. Stale execution credentials cannot acknowledge or reply as the current occupant.
- Persist five application tables: crews, seats, executions, messages, and delivery_attempts. Add ordinary schema migration tracking as infrastructure. Use foreign keys, indexes for active execution and pending delivery lookup, and transactions for coupled mutations.
- Crew configuration includes its name, project location, seat names, role sources, supported runtime selection, and working directories. Resolve relative references against the configuration location. Validate role sources and working directories before launch. Record a digest of effective configuration to detect changes on subsequent startup.
- Agent context consists of role instructions, the project location and applicable native project guidance, its managed identity, the teammate roster, and coordination command instructions. Respect existing project guidance rather than overwriting it. Do not imply that every project file has been loaded into context.
- Expose daemon commands: `crew daemon start`, `crew daemon status`, and `crew daemon stop`. Starting an already healthy daemon succeeds. Enforce a single daemon for the selected state directory. Stopping the daemon leaves managed terminals running and suspends delivery.
- Expose crew lifecycle commands: `crew up <config.yaml>`, `crew status [--crew <name>]`, and `crew down --crew <name>`. Startup starts the daemon if necessary, reuses healthy matching executions, reports configuration mismatches, and does not silently restart seats with unexplained execution state. Crew shutdown stops its managed executions, preserves records, and leaves outstanding messages pending or uncertain as appropriate.
- Partial launch failure must be visible per seat. Clean up newly created processes that cannot be registered. Do not report the whole crew as ready while required seats failed. Repeating startup can complete missing launches without duplicating confirmed healthy executions.
- Expose discovery commands: `crew whoami` and `crew members [--crew <name>]`. Managed agents derive the crew from their execution environment. Human callers may omit crew selection only when exactly one eligible crew makes the operation unambiguous.
- Expose messaging commands: `crew send <seat>`, `crew reply <message-id>`, `crew ack <message-id>`, `crew inbox [--all]`, `crew message show <message-id>`, and `crew message retry <message-id> [--allow-duplicate]`.
- Sending and replying require exactly one of `--text` or `--body-file`; a body-file value of `-` reads standard input. Preserve Unicode, newlines, quotes, backticks, and other literal message content. Never construct shell commands by interpolating the body.
- Provide `--json` for inspection and messaging commands. Keep diagnostics on standard error. Successful messaging returns the persisted message ID and delivery state. Invalid input or definite request failure returns a nonzero exit status. A pending recipient is not a persistence failure.
- The daemon's local HTTP interface mirrors the domain operations exposed by the CLI. Mutations validate caller identity and crew scope. Message submission commits the message and initial pending attempt in one transaction before returning acceptance. The delivery worker operates afterward; the request does not wait indefinitely for recipient readiness.
- Include a stable request identifier on message submission. Retrying the same request with identical content returns the original message; reuse with different content fails. A transport timeout without a response is an unknown request outcome, not proof that the message was never persisted.
- Messages record the sender seat or operator, sender execution where applicable, recipient seat, immutable body, creation time, original-message reference for replies, and acknowledgment evidence. Delivery attempts separately record the target execution, generation, observed pane, timestamps, outcome, and failure reason. A reply is a new message addressed to the original sender; operator-directed replies remain inspectable through the CLI without requiring a human terminal seat.
- Delivery proceeds through pending, submitting, submitted, failed, or uncertain attempt states. Resolve the current execution, serialize delivery per seat, wait for a supported ready-input condition, and revalidate execution/generation/pane immediately before injection. Persist submitting before the first input-affecting operation.
- Do not inject during detected permission dialogs, selection menus, existing drafts, or unknown input state. Unknown readiness remains pending with an inspectable reason. Support runtime-specific readiness detection for the first runtime; avoid pretending there is a universal terminal-ready heuristic.
- Paste the entire message envelope through a tmux buffer and submit it with a separate Enter. The envelope contains the message ID, sender, recipient, full body, and reply guidance. Use process argument arrays or private input files for tmux integration instead of message interpolation into shell strings.
- Submitted means the submission operations completed; it does not mean the agent understood or finished work. An optional render observation is additional evidence, not receipt. Explicit acknowledgment records receipt by an authorized recipient execution. Repeated acknowledgment is idempotent. Reading does not acknowledge.
- Persist replies and acknowledgment of their original message transactionally. Only an authorized execution of the recipient seat may acknowledge or reply as that seat. Reply relationships remain available after either execution stops.
- On daemon restart, reconcile recorded executions against observable managed processes without claiming a missing or mismatched process is healthy. Resume pending deliveries to confirmed eligible executions. Attempts left submitting become uncertain. Do not automatically retry submitted or uncertain attempts. Do not promise exactly-once terminal delivery.
- Explicit retry creates a new attempt without rewriting earlier history. Uncertain attempts require `--allow-duplicate`. Reject retry of acknowledged messages. Message IDs remain constant across retries and appear in every injected envelope.
- Store context and project artifacts on disk and native conversation history in the runtime's own storage. SQLite stores coordination records and relevant references, not a copy of the agent's complete memory.
- Initial operating assumption: agents may share a project working directory, but only one agent writes implementation files at a time. Roles describe this convention; they are not enforced permissions. Automated worktree isolation and permission management are outside the MVP.

## Testing Decisions

- Implement one ticket at a time. After its automated checks pass, present a runnable manual validation procedure with expected outcomes and stop implementation until the user explicitly signs off. Do not start another ticket, including an independent ticket, while validation is pending. If validation finds a problem, fix the current ticket and repeat the relevant checks. A blocker is complete only after the user's manual acceptance, not merely after implementation or automated tests. Record sign-off only when actually supplied by the user.
- Confirmed test seams: the public CLI for end-to-end acceptance flows, plus the daemon's local HTTP interface for direct contract and state-transition tests. Both use a real daemon and temporary SQLite storage. Verify returned output, exit codes or HTTP status, observable execution behavior, message history, and recovery.
- Direct HTTP tests cover request validation, identity and crew scope, idempotent message submission, acknowledgment/reply authorization, retry eligibility, and persisted outcomes across restart. CLI tests cover argument handling, standard input, JSON output, human-readable outcomes, and representative lifecycle/message flows. Avoid repeating every daemon case through the CLI.
- Good tests assert externally meaningful behavior, not private functions, exact SQL statements, internal call sequences, or tmux command formatting. Cover failures that could lose messages, duplicate execution, corrupt attribution, or submit input to the wrong occupant.
- Exercise crew lifecycle, identity/context setup, messaging, acknowledgment/reply, and delivery recovery through that seam. Internally controlled process and terminal observations may make failure scenarios deterministic, but should not create additional public interfaces.
- Main acceptance scenario: launch planner, coder, and reviewer; send an implementation request; receive a coder reply and review request; receive reviewer findings; stop and restart the daemon; verify seat identity, surviving executions, and unread message history remain available.
- Verify valid configuration launches once; invalid references launch nothing; repeated startup does not duplicate healthy agents; changed configuration is reported; partial launch failure is visible and does not strand unregistered processes.
- Verify roles, roster, identity, and coordination instructions reach the configured execution without destructive modification of existing project guidance.
- Verify persisted message content and injected content retain multiline text and shell-sensitive characters. A successful send returns a durable ID even when delivery is deferred.
- Verify stopped recipients retain pending messages; unsafe or unknown input defers delivery; concurrent sends do not interleave; replacing a recipient between resolution and injection prevents delivery to the stale target.
- Verify reading does not acknowledge, acknowledgment is idempotent and recipient-scoped, replies link to and acknowledge their original, and operator-directed replies are visible.
- Verify repeated submission with one request identity does not create duplicate messages. A conflicting reuse is rejected. Simulate a lost HTTP response after persistence and recover the original result.
- Fault-injection cases include a crash before message commit, after commit but before input, during paste or submit, and after submit but before outcome persistence. Before-commit failure must leave no accepted message; pending attempts recover; ambiguous input attempts become uncertain and do not automatically resend.
- Verify explicit uncertain retry requires duplicate acceptance, creates a new historical attempt, and cannot resend an acknowledged message. Verify stale execution credentials cannot impersonate the current occupant.
- Add a small real-tmux integration suite and an opt-in smoke test using the selected native agent runtime. Deterministic tests must not depend on paid model calls or a model choosing a particular response. Real-agent smoke testing establishes that launch, context setup, and terminal injection work with an installed runtime.
- Prior art exists in the inspected OpenRig checkout: CLI launch/send/lifecycle tests and daemon event, identity, and delivery-guard tests. There is no identified MVP repository or existing MVP test suite, so these are reference patterns rather than an established local testing convention. OpenRig's full test suite has not been executed during this research.

## Out of Scope

- Project catalogs, missions, slices, workflow execution, and task queues.
- Proof policies, acceptance judgments, and mandatory review gates.
- Automatic agent replacement, exact native conversation restore, snapshots, compaction orchestration, and learned-memory systems.
- Autonomous planning, classifier agents, watchdog policy frameworks, and automatic escalation.
- Remote hosts, distributed coordination, external chat integrations, and network-accessible deployment.
- Browser interfaces, custom TUI development, packages/plugins, and service orchestration.
- Concurrent multiwriter worktree management and operating-system sandbox or permission administration.
- Guaranteed understanding, completion, or exactly-once processing of agent messages.
- More than one native runtime in the first implementation milestone; additional runtime support must be separately validated.

## Further Notes

- The central accepted design is to persist the full message and then type it into the recipient's existing interactive chat. Inbox retrieval supports inspection and recovery; it is not the default delivery mechanism.
- Crew is the working name, not a checked package-name or executable availability claim.
- The stack, first-runtime choice, request idempotency, and credential details are proposed implementation decisions completing the conversational design. Review them with the rest of this draft before implementation.
- The user selected crew as the project workspace. No existing MVP implementation, domain glossary, ADRs, or external issue tracker has been identified there. The approved ticket breakdown is retained locally; external publication remains pending configuration.
- The to-spec skill requires publication to the configured project issue tracker with `ready-for-agent`. Run `/setup-matt-pocock-skills` to configure the missing tracker. This draft has not been published or labeled.
