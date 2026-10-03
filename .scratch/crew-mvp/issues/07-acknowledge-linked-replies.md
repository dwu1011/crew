# 07: Acknowledge messages and exchange linked replies

**What to build:** Recipients can explicitly acknowledge messages or reply with a new linked message, letting senders distinguish submission from receipt and follow a conversation.

**Blocked by:** 05: Persist and inspect messages (including manual acceptance).

**Status:** ready-for-agent

- [ ] Only an authorized current execution of the recipient seat can acknowledge or reply as that seat; crew scope and stale credentials are enforced.
- [ ] Explicit acknowledgment records execution and timing evidence, and repeating it is idempotent.
- [ ] Reading a message does not acknowledge it; inbox filtering reflects actual acknowledgment evidence.
- [ ] Reply creation and acknowledgment of the original commit together. A reply has its own immutable message ID, original-message reference, and pending delivery attempt.
- [ ] Replies route to the original sender seat. Replies to a human operator remain inspectable without a human terminal seat or fictitious pane delivery.
- [ ] Reply body handling and request idempotency follow the same contracts as sending. Inspection exposes linked replies and original-message receipt.
- [ ] CLI and direct HTTP tests verify authorization, atomic reply/receipt, idempotency, inbox filtering, and human-directed replies. Persisted replies are independently demoable even before terminal delivery is available.

## Manual validation

- [ ] Read an incoming message and verify it remains unacknowledged; acknowledge it twice and verify one stable receipt outcome.
- [ ] Reply from its recipient and inspect the original acknowledgment plus the newly linked message.
- [ ] Attempt acknowledgment from another seat and verify rejection; reply to an operator and verify the reply is inspectable.

## Completion gate

Supply exact manual commands and expected outcomes after automated checks pass. Stop until the user explicitly signs off. No manual acceptance has been recorded.
