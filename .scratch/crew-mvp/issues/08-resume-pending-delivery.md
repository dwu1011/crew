# 08: Resume pending delivery when recipients become available

**What to build:** Messages sent while a recipient is stopped or the coordinator restarts remain available and are submitted once a confirmed current execution becomes ready.

**Blocked by:** 04: Manage crew lifecycle without duplicate executions; 06: Deliver full messages into agent terminals (both including manual acceptance).

**Status:** completed

- [x] Messages addressed to stopped seats remain pending and are considered when the seat is launched again through supported crew startup.
- [x] Daemon restart reconciles executions before processing pending deliveries; confirmed surviving executions retain their identities and generations.
- [x] Pending attempts recover from persisted state rather than relying on lost in-memory queues.
- [x] Attempts identify the execution actually targeted; an execution change before input prevents delivery to a stale pane and requires a fresh resolution.
- [x] Submitted attempts are not automatically resubmitted merely because a recipient relaunched.
- [x] Crew shutdown suspends its eligible delivery without deleting messages; daemon shutdown preserves terminal execution and outstanding records.
- [x] CLI and direct HTTP tests cover stopped recipients, restart after persistence but before input, generation changes, and duplicate suppression for submitted messages.

## Manual validation

- [x] Stop a crew, persist a message to a seat, relaunch the crew, and observe delivery to the new execution with the same message ID.
- [x] Persist pending work while input is unsafe, restart the daemon, make the recipient ready, and verify eventual submission.
- [x] Restart after a successful submission and verify that the message does not appear again automatically.

## Completion gate

Provide exact steps, expected identities, and delivery outcomes after automated checks pass. The user authorized delegated validation and sequential progression on 2026-10-04. Validation passed; proceed to ticket 9.


## Validation evidence

- Implementation: `22c222b`. Typecheck passed; final suite: 64 passed, 1 opt-in smoke skipped.
- Standards/spec review baseline `da16e6f`: no findings.
- Real Claude validation: stopped-seat message survived daemon restart and reached a fresh execution/generation with its original message ID. Unsafe draft survived restart; clearing it enabled automatic delivery on the same execution/generation/native session. A further restart did not replay submitted messages.
- Report: `/private/tmp/crew-native8-XJUly7/report.json`. Validation crew and daemon were stopped.
- CLI/HTTP tests cover persisted queues, reconciliation, surviving identity, new-generation targeting, and submitted-message duplicate suppression. Known pre-input target/cursor changes remain pending for fresh resolution; ambiguous post-input failures remain uncertain.

## Reproduce

```sh
bun run build
export CREW_HOME="$(mktemp -d /tmp/crew-manual-8.XXXXXX)"
bun run crew up examples/single-seat/crew.yaml --json
bun run crew status --crew demo --json
bun run crew down --crew demo --json
bun run crew send investigator --crew demo --text 'No tools or edits. Reply RELAUNCH_OK.' --json
bun run crew daemon stop
bun run crew daemon start
bun run crew up examples/single-seat/crew.yaml --json
bun run crew attach --crew demo
```

Finish native prompts. If its initial suggestion cannot be confirmed empty, manually ask `Reply READY only. No tools or edits.` and wait. Expected: the pending message automatically appears; its attempt records the new execution/generation, while seat ID and message ID remain stable. Use short lines and a wide terminal for exact draft verification. Detach with Ctrl-a then d.

In the agent input, type `MY_RESTART_DRAFT` without Enter and detach. Then:

```sh
bun run crew send investigator --crew demo --text 'No tools or edits. Reply RESTART_OK.' --json
bun run crew daemon stop
bun run crew daemon start
bun run crew status --crew demo --json
bun run crew inbox --crew demo --all --json
bun run crew attach --crew demo
```

Expected: pending with a draft reason; daemon stop preserves the terminal. Restart preserves execution ID, generation, and native session. The draft is untouched. Clear the single-line draft with Ctrl-u and wait for automatic delivery. Inspect the original message ID: submitted, one attempt.

```sh
bun run crew daemon stop
bun run crew daemon start
bun run crew inbox --crew demo --all --json
bun run crew attach --crew demo
```

Expected: previously submitted envelopes do not appear again automatically; attempt IDs/timestamps remain unchanged. Cleanup:

```sh
bun run crew down --crew demo --json
bun run crew daemon stop
```
