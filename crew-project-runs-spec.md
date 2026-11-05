> Retention amendment, 2026-10-08: at the user’s request, successful `crew down` now clears the selected crew’s messages and delivery attempts while preserving execution history. Operator-only `crew message clear` clears saved messages without stopping agents. Failed shutdown and daemon restart preserve messages. This supersedes message-retention requirements across explicit crew shutdown below; historical launch context remains retained. See [operations](docs/guides/operations.md).

## Problem Statement

A user wants one reusable planning crew definition that they can launch in different project folders. Today, a crew YAML binds its name, roles, project, and working directories together. Launching the same definition from another folder does not change that binding, and the global command cannot select a reusable planning profile independently of its project.

Copying and editing definitions for every project duplicates role maintenance. Reusing the same running conversations across unrelated projects mixes assumptions, work, and history. The user wants reusable roles with separate project runs.

## Solution

Introduce reusable crew profiles and project-bound crew instances. A profile defines seats, roles, and runtimes. A project run is the crew instance bound to one profile and one canonical project folder; it is not a new instance for every launch command.

Provide a globally available planning profile with planner, architect, and critic seats. From a project folder, the user can run `crew up --profile planning` without copying a configuration into that project. The current folder becomes the project root unless the user supplies `--project`.

The same profile can run in several projects simultaneously. Each project run has its own crew identity, seats, executions, credentials, messages, delivery attempts, and history. Returning to a project reuses its existing run rather than borrowing another project's conversations.

Project-aware commands select the run associated with the caller's folder. Explicit crew selection remains available. The existing configuration-based launch remains supported.

## User Stories

1. As a user, I want a reusable planning profile, so that I can use the same planning roles for several projects.
2. As a user, I want the planning profile available after installing the global command, so that I can start without creating a project-specific configuration.
3. As a user, I want to launch a profile from my current folder, so that the agents receive the project I am actually working on.
4. As a user, I want to select another project folder explicitly, so that I can launch its crew without changing my shell's directory.
5. As a user, I want project roots to be ordinary existing folders, so that planning a new project does not require a Git repository.
6. As a user, I want one profile running in two projects simultaneously, so that I can plan both without shutting either crew down.
7. As a user, I want distinct project folders with the same basename to remain distinct, so that similarly named repositories cannot share a crew accidentally.
8. As a user, I want symlink aliases of one project folder to resolve to the same run, so that alternate paths do not create duplicates.
9. As a user, I want repeated launch requests for the same profile and project to reuse healthy executions, so that I do not accidentally create duplicate agents.
10. As a user, I want separate conversations and credentials for each project run, so that work and identity stay associated with the correct project.
11. As a user, I want each agent to receive its reusable role and the selected project's guidance, so that specialization and project context both inform its work.
12. As a user, I want the planner to clarify goals and coordinate the architect and critic, so that I receive one coherent project plan.
13. As a user, I want planning agents to wait for my brief, so that starting a crew does not invent a project or begin unsolicited work.
14. As a user, I want plans to include scope, implementation slices, acceptance criteria, verification, risks, and open decisions, so that the output is actionable.
15. As a user, I want planning agents to preserve project files unless I request a written artifact, so that discussion alone does not modify my repository.
16. As a user, I want to register my own reusable profile once, so that custom roles are available from other folders.
17. As a user, I want to list and inspect available profiles, so that I can see their seats and role sources before launch.
18. As a user, I want profile registration to report naming conflicts, so that one definition does not silently replace another.
19. As a user, I want invalid profiles, role references, and working directories rejected before any agent starts, so that a configuration error cannot partially launch a crew.
20. As a user, I want status to show the profile, project root, and actual crew name, so that I can tell which run I am inspecting.
21. As a user, I want attach and detach to select the crew for my current project, so that I can inspect its seats without memorizing generated names.
22. As a user, I want messages sent from a project folder to reach that project's seat, so that identical seat names in other projects do not cause misrouting.
23. As a managed agent, I want coordination commands to derive my crew from my execution credential, so that my current shell directory cannot redirect teammate communication.
24. As a managed agent, I want attempts to address another project run rejected, so that execution credentials remain scoped to their own crew.
25. As a user, I want explicit crew selection to work from any folder, so that I can deliberately inspect or operate another run.
26. As a user, I want ambiguous project or profile selection reported with available choices, so that the command never guesses which crew should receive work.
27. As a user, I want shutting down one project run to preserve other runs, so that independent planning can continue.
28. As a user, I want daemon restart to retain project bindings and reconcile surviving executions, so that I can recover without rebuilding the profile or losing history.
29. As a user, I want relaunch after explicit crew shutdown to create new executions while preserving that project's recorded history, so that I can continue using the same project run safely.
30. As a user, I want uncertain delivery and missing-terminal recovery to retain existing explicit retry and shutdown requirements, so that project-aware launch cannot duplicate work silently.
31. As a user, I want changes to a profile to leave existing executions' instructions intact, so that a running crew's behavior does not change without a new launch.
32. As a user, I want an explicitly stopped run to accept a revised profile on its next launch while retaining history, so that role improvements can be adopted deliberately.
33. As a user, I want existing crew YAML files and explicit crew commands to continue working, so that this feature does not force a migration of my current setup.
34. As a user, I want the daemon HTTP interface to expose the same profile and project behavior as the CLI, so that other clients can use the feature reliably.

## Implementation Decisions

- Extend the domain vocabulary with Profile and Project run. A Profile is a reusable seat-and-role definition. A Project run is a persistent project-bound Crew. A launch creates or reuses Executions within that Crew; it does not create a new project run on every invocation.
- Support globally discoverable named profiles within the selected Crew state directory. Ship the planning profile and support explicit registration, listing, and inspection of user profiles. An alternate state directory isolates profile registrations and run state as it does other daemon state.
- Profile registration resolves its source location explicitly. Role references remain relative to the profile source, never the caller's project folder. Registration reports conflicting identifiers rather than overwriting an unrelated profile silently. Project runs store the resolved profile identity, not merely a display name.
- Extend the Up interface with profile selection and an optional project override. Configuration-based launch and profile-based launch are mutually exclusive. The CLI supplies its invocation directory when profile launch has no project override.
- Profile definitions carry reusable seats, role references, and runtime settings. The project binding is supplied at launch. A legacy configuration's fixed project remains meaningful only for its existing configuration-based launch mode; profile registration must expose clearly which fields become reusable and which project binding fields do not apply.
- Seat definitions may explicitly select `skills` and `mcp_servers`. Omitted lists retain native inheritance; empty lists select none independently. An optional profile/configuration `mcp_config` supplies a native JSON registry for named server selections. Resolve and validate selections before launch, snapshot selected resources per execution, and include them in launch compatibility checks. Inspection must retain historical selections without exposing server credentials. Explicit skill selection uses lazy file-based instruction loading with native skill/command discovery disabled; explicit MCP selection uses strict native configuration. See [configuration and runtime limits](docs/guides/operations.md#per-seat-skills-and-mcp-servers).
- Require the selected project root to be an existing directory. Resolve relative project overrides against the invoking shell's directory and canonicalize through the filesystem before looking up or creating a run. Do not infer project identity from a repository basename, Git remote, or profile source directory. Git is optional.
- Identify a project run by the pair of resolved profile identity and canonical project root. Enforce uniqueness in SQLite so concurrent equivalent launches reuse one run. Existing crew-name uniqueness remains intact; derive a stable, valid, readable crew name with collision-safe disambiguation and return it to the user.
- Default profile seats' working directories to the bound project root. Relative seat working-directory references resolve against that root and must remain within it. Validate all seats and role files before creating terminals. Existing legacy working-directory resolution remains unchanged.
- Keep authored profile data separate from captured launch instructions. Record the effective role and project binding used by an Execution so later profile edits do not rewrite that Execution's context or its history.
- Load project guidance from the selected project using the existing context assembly behavior. Supply the run's actual crew identity, seat identity, roster, and coordination instructions. An agent in project A must not receive project B's guidance or execution identity simply because both runs use the same profile.
- Resolve human-operated commands using explicit crew selection first. Otherwise use the supplied project context and optional profile selection to choose a run. Commands from a descendant folder select the most specific existing bound project root containing that folder. Multiple profiles at that root require an explicit profile or crew choice. No matching profile run produces an actionable error rather than selecting a run in another project.
- Keep the current fallback behavior for legacy crews where applicable. The CLI forwards its invocation directory to project-aware selection; the daemon must not infer a human caller's project from the daemon process's own working directory. Existing HTTP callers that supply no new selector retain the legacy selection contract.
- Managed execution credentials remain the primary selector for agent commands. Conflicting explicit crew, profile, or project selectors are rejected. Teammate discovery, sends, acknowledgments, replies, retries, and delivery issue inspection remain scoped to the credential's Crew.
- Extend status and roster responses additively with profile identity and canonical project root for profile-bound runs. Return the actual crew name and existing execution, generation, terminal, and delivery metadata. Legacy crews have no invented profile association.
- Extend the existing daemon launch interface to accept either a legacy configuration reference or a profile identity with an absolute project root. Validate malformed or mixed requests, missing profiles, and invalid directories before terminal creation. Add equivalent project/profile selectors to existing operator interfaces; preserve existing credential and error contracts.
- Use the existing shared SQLite database and daemon. Add persistent profile/run association metadata and uniqueness enforcement through the Database bootstrap module. Upgrade existing databases without discarding crews, seats, executions, messages, delivery attempts, or lifecycle identity.
- Keep the existing ownership and reconciliation protocol. Repeated startup reuses verified healthy Executions. Unknown, mismatched, or missing terminals are not silently replaced. Daemon restart reuses surviving native sessions after verification. Explicit crew shutdown permits fresh Executions and revokes old credentials while retaining history.
- Apply revised profile content only during an explicit launch after all prior affected Executions are verified stopped. Reject incompatible changes while executions remain active or unverified. Preserve historical launch context and messages, and distinguish current roster membership from retained history when seats change.
- Keep message acceptance, acknowledgment, delivery attempts, native prompt receipts, and task completion distinct. Reuse the existing DeliveryAttempts and ManagedExecutions interfaces; retain pending recovery, explicit retries, uncertainty handling, protected prompt intents, and crew-wide serialization through receipt waiting.
- Project-aware shutdown, attach, and detach operate on the selected Crew and do not stop or disconnect another project's agents. Daemon shutdown retains its current behavior of leaving managed agent sessions running.
- Ship planning behavior through role instructions: planner consolidates, architect proposes designs, and critic reviews feasibility and verification. Starting the profile waits for a brief. File-writing restraint is behavioral guidance and does not change native tool permissions.

## Testing Decisions

- Use the existing public Crew CLI and direct daemon HTTP interfaces as the acceptance seams, as confirmed by the user. Exercise external behavior rather than private method calls, internal hash formats, SQL query text, or construction order.
- Test the configuration/profile resolution, crew lifecycle, coordination, delivery, managed input, and database bootstrap modules through those same surfaces. Prefer the existing real SQLite and tmux test environment with the controlled native agent fixture over new mocks or testing-only interfaces.
- Extend prior launch/context tests to verify that one profile launches in two different folders with the same seats and role instructions but distinct identities, project guidance, credentials, and working directories.
- Test the bundled planning profile and a registered custom profile from outside their definition folders. Verify registration conflicts, missing roles, invalid project roots, and working-directory escape validation create no terminals.
- Exercise canonical path aliases, same-basename projects, concurrent equivalent launches, and repeated startup. Assert stable run identity and distinct execution ownership through returned CLI/HTTP data, not the naming algorithm's internal representation.
- Test project-aware command selection from project roots, descendant folders, unrelated folders, and folders with multiple profiles. Include explicit crew overrides and direct HTTP requests with and without new selectors.
- Extend existing authenticated identity and messaging tests to use two runs with identical seat names. Verify messages, replies, acknowledgments, inboxes, histories, and delivery issues remain in the correct run; forged cross-run selectors and credentials are rejected.
- Verify stopping or detaching one run leaves the other unchanged. Restart the daemon with both runs present and confirm bindings, surviving execution identities, stored history, and pending delivery recovery remain correct.
- Extend existing generation and configuration-change tests for stopped-run profile revisions. Verify new launches receive revised instructions, old credentials are revoked, and previous launch context and message history remain associated with their original executions.
- Preserve existing terminal safety, uncertain retry, native receipt replay, acknowledgment-during-preparation, and isolated crash-phase tests. Profile selection must not bypass those guarantees.
- Extend historical database upgrade tests with legacy crews and existing message/attempt history. Assert upgraded legacy behavior and new profile-run uniqueness through public requests.
- Retain the opt-in real Claude messaging/recovery smoke test and extend it to exercise planning-profile launch and project context. Deterministic fixtures establish isolation and contracts; the native smoke validates integration, not subjective planning quality.

## Out of Scope

- One running conversation automatically switching projects when the human changes shell directories.
- Sharing agent conversations or automatically merging messages and history between project runs.
- A project catalog, project manifests, cross-project task routing, workflows, task queues, or a new memory/learning system.
- Restoring an ended native model conversation after explicit crew shutdown; fresh Executions retain recorded Crew history without promising native conversation resumption.
- Hot-reloading role instructions into running agents, automatic relaunch on profile edits, or automatic migration of a run when its project folder moves.
- Remote hosts, additional agent runtimes, a generic runtime framework, a profile marketplace, bundle distribution, or a new UI/MCP interface.
- Enforcing planning-only behavior through a new sandbox or permission policy.
- Changing the existing crew-wide concurrency model, retry policy, native input protocol, or delivery guarantees.
- Implementing the project that the planning crew discusses.

## Further Notes

The user selected reusable planning roles in separate project runs. The existing planning example supplies the planner, architect, and critic responsibilities; no project brief is required to make that profile available.

Global command installation and reusable role availability are separate from project-specific Executions. A current-directory default is an operator convenience at launch and selection time, not a promise that running agents follow later shell directory changes.

This spec extends the current MVP rather than reproducing OpenRig's entire project/workspace system. Preserve existing legacy configurations and operator access while adding explicit profile and project identities.

The target issue tracker is GitHub Issues for dwu1011/crew. Apply ready-for-agent when publishing; no additional triage is required.
