# 09: Recover uncertain submissions and explicitly retry failures

**What to build:** Humans can distinguish definite delivery failure from a possibly submitted message after a crash, and deliberately retry without losing prior attempt history or claiming exactly-once delivery.

**Blocked by:** 07: Acknowledge messages and exchange linked replies; 08: Resume pending delivery when recipients become available (both including manual acceptance).

**Status:** completed

- [x] Startup converts abandoned submitting attempts into uncertain outcomes rather than silently resetting them to pending.
- [x] Message and crew inspection expose unresolved uncertain/failed attempts with reasons and complete historical attempts.
- [x] Explicit retry creates a new attempt for the same message ID. Uncertain delivery requires the duplicate-acceptance option; ordinary retry suffices only for an eligible definite failure.
- [x] Retry rejects acknowledged messages and does not introduce competing active attempts for one message. Pending delivery also skips messages already acknowledged. Authorization and crew scope apply to retry requests.
- [x] Fault tests cover crashes before commit, after commit before input, during paste/submission, and after submission before outcome persistence. Confirm message preservation, uncertainty, and lack of blind resend.
- [x] Provide a reproducible isolated validation method for crash intervals, without requiring the user to time a process kill manually or risking their normal project sessions.
- [x] The completed MVP supports an opt-in real-agent smoke scenario: planner requests work, coder replies and requests review, reviewer responds, and daemon restart preserves identities and message history. Deterministic automated tests do not rely on paid model calls or exact model wording.
- [x] Both CLI acceptance tests and direct HTTP tests exercise retry contracts and observable recovery outcomes.

## Manual validation

- [x] Use the supplied isolated scenario to interrupt delivery after input may have occurred; restart and verify uncertain status with no automatic resend.
- [x] Attempt retry without duplicate acceptance and verify rejection; explicitly allow a duplicate and verify a new attempt with the original message ID and preserved history.
- [x] Acknowledge a message and verify that further retry is rejected.
- [x] Run the planner/coder/reviewer conversation, restart the daemon, and inspect surviving execution identities, replies, and unread messages.

## Completion gate

The user authorized delegated validation, sequential implementation, and a separate PR per slice on 2026-10-04. The isolated crash procedure, real-agent demonstration, typecheck, and final suite passed. All nine MVP slices are implemented.

## Reproduce isolated crash validation

From the crew repository:

```sh
bun run build
bunx vitest run test/agent.test.ts -t 'isolated |explicit definite-failure retry|acknowledgment during preparation'
```

Each scenario creates its own temporary project, SQLite state, daemon, tmux socket, and controlled external Claude fixture. The wrapper interrupts a precise terminal operation, so no manually timed process kill is needed. Cleanup stops the owned daemon and terminals and removes the temporary directory. No model calls or normal project sessions are used.

Expected checks:

- Incomplete HTTP input before commit leaves no message. A committed message survives restart with one pending attempt and its original ID; resubmitting its request ID does not duplicate it.
- Crashes before paste, after paste, and after Enter leave a submitting attempt that restart converts to uncertain. There is no blind resend. The after-Enter case explicitly demonstrates that accepting a retry can submit a duplicate.
- CLI and HTTP retries without duplicate acceptance reject uncertain delivery. `--allow-duplicate` / `allowDuplicate: true` appends a new attempt to the same message, retaining the prior attempt unchanged.
- Definite failure can retry without duplicate acceptance. Active, submitted, and acknowledged messages reject retry. An acknowledgment during preparation prevents input.
- Retry authorization and crew/participant inspection scope are enforced.

## Reproduce native MVP demonstration

```sh
bun run build
CREW_NATIVE_MVP_SMOKE=1 bunx vitest run test/agent.test.ts -t 'native crew messaging and recovery smoke'
```

Requires authenticated Claude Code 2.1.289 and tmux. This opt-in scenario makes model calls. `CREW_NATIVE_BIN` can select the native executable. It creates a private read-only project and three role files, accepts only that project's recognized trust prompt, disables prompt suggestions in the validation daemon's environment, and waits for ready terminals. It does not clear drafts during message delivery.

The operator requests planner coordination; planner sends coder an inspection request; coder reads the source, replies to planner, and requests reviewer review; reviewer replies to coder; planner replies to the original operator request. Assertions inspect linked messages through the public CLI rather than exact model wording. Restart preserves seat IDs, execution IDs, generations, native session IDs, message bodies, reply links, and acknowledgment timestamps. Unread inspection returns only unacknowledged messages. Source remains unchanged. Cleanup stops the validation crew, terminals, and daemon.

## Validation evidence

- Implementation `d7d1701`, native-validator correction `132ebce`.
- All targeted deterministic fault/retry tests passed. Native MVP smoke passed in 31 seconds; output: `/private/tmp/crew-ticket9-native-smoke.log`.
- Final typecheck passed. Full deterministic suite: 71 passed, 2 opt-in native tests skipped. The complete native MVP smoke was run separately and passed. Validation-owned crews, terminals, and daemons were stopped.
- Standards and spec review baseline `05c7a8b`: no remaining findings. Review caught an input-clearing race in the validator; removing intervention during polling and disabling suggestions before launch resolved it.
