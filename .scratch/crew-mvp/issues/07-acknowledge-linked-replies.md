# 07: Acknowledge messages and exchange linked replies

**What to build:** Recipients can explicitly acknowledge messages or reply with a new linked message, letting senders distinguish submission from receipt and follow a conversation.

**Blocked by:** 05: Persist and inspect messages (including manual acceptance).

**Status:** completed

- [x] Only an authorized current execution of the recipient seat can acknowledge or reply as that seat; crew scope and stale credentials are enforced.
- [x] Explicit acknowledgment records execution and timing evidence, and repeating it is idempotent.
- [x] Reading a message does not acknowledge it; inbox filtering reflects actual acknowledgment evidence.
- [x] Reply creation and acknowledgment of the original commit together. A reply has its own immutable message ID, original-message reference, and pending delivery attempt.
- [x] Replies route to the original sender seat. Replies to a human operator remain inspectable without a human terminal seat or fictitious pane delivery.
- [x] Reply body handling and request idempotency follow the same contracts as sending. Inspection exposes linked replies and original-message receipt.
- [x] CLI and direct HTTP tests verify authorization, atomic reply/receipt, idempotency, inbox filtering, and human-directed replies. Persisted replies are independently demoable even before terminal delivery is available.

## Manual validation

- [x] Read an incoming message and verify it remains unacknowledged; acknowledge it twice and verify one stable receipt outcome.
- [x] Reply from its recipient and inspect the original acknowledgment plus the newly linked message.
- [x] Attempt acknowledgment from another seat and verify rejection; reply to an operator and verify the reply is inspectable.

## Completion gate

Supply exact manual commands and expected outcomes after automated checks pass. The user authorized delegated validation and sequential progression on 2026-10-04. Validation passed; proceed to ticket 8.


## Validation evidence

- Implementation: `20f0cc9`. Typecheck passed; final suite: 62 passed, 1 opt-in smoke skipped.
- Standards/spec review baseline `6bdf269`: no remaining findings.
- Real Claude recipient ran message inspection, acknowledgment twice, and linked reply. Receipt identifies its execution; the operator reply has no terminal delivery attempt.
- Upgrade from the ticket-6 database preserved existing message IDs, order, bodies, timestamps, and complete delivery evidence. Report: `/private/tmp/crew-validate-6-final-QWPcyY/ticket7-report.json`.
- CLI/HTTP tests verified other-seat/operator rejection, stale credentials, atomic conflict rollback, stable reply IDs, inbox filtering, file body handling, and restart persistence. Native sessions and daemon were stopped.

## Reproduce

```sh
bun run build
export CREW_HOME="$(mktemp -d /tmp/crew-manual-7.XXXXXX)"
bun run crew up examples/three-seat/crew.yaml --json
bun run crew send coder --crew demo-crew --text 'Read-only validation. No project edits.' --json
bun run crew attach --crew demo-crew
```

Use the returned message ID. In coder's terminal, ask it to run these commands (replace ID):

```sh
crew message show ID --json
crew ack ID --json
crew ack ID --json
crew reply ID --text 'Operator findings.' --request-id manual-7-reply --json
```

Expected: inspection initially leaves acknowledgment null; both ack calls return the same first execution/timestamp. Reply records its own ID and replyTo, and acknowledges the original in the same transaction. Its recipient is operator and deliveries is empty. Repeat the reply command for the same ID; changed content with that request ID must conflict without another reply. Ask planner to acknowledge ID: it must be rejected. Agents cannot select another crew or use a stopped execution credential.

Detach the crew view with Ctrl-a then d:

```sh
bun run crew message show ID --crew demo-crew --json
bun run crew inbox --crew demo-crew --json
bun run crew inbox --crew demo-crew --all --json
bun run crew daemon stop
bun run crew daemon start
bun run crew message show ID --crew demo-crew --json
bun run crew down --crew demo-crew --json
bun run crew daemon stop
```

Expected: original receipt and linked reply survive restart; unread filtering excludes the acknowledged original. Operator replies remain inspectable. For seat-to-seat routing, have planner send coder a message, then have coder reply to that ID: its recipient is planner and it has an independent pending/submitted delivery attempt.
