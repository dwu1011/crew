# 09: Recover uncertain submissions and explicitly retry failures

**What to build:** Humans can distinguish definite delivery failure from a possibly submitted message after a crash, and deliberately retry without losing prior attempt history or claiming exactly-once delivery.

**Blocked by:** 07: Acknowledge messages and exchange linked replies; 08: Resume pending delivery when recipients become available (both including manual acceptance).

**Status:** ready-for-agent

- [ ] Startup converts abandoned submitting attempts into uncertain outcomes rather than silently resetting them to pending.
- [ ] Message and crew inspection expose unresolved uncertain/failed attempts with reasons and complete historical attempts.
- [ ] Explicit retry creates a new attempt for the same message ID. Uncertain delivery requires the duplicate-acceptance option; ordinary retry suffices only for an eligible definite failure.
- [ ] Retry rejects acknowledged messages and does not introduce competing active attempts for one message. Pending delivery also skips messages already acknowledged. Authorization and crew scope apply to retry requests.
- [ ] Fault tests cover crashes before commit, after commit before input, during paste/submission, and after submission before outcome persistence. Confirm message preservation, uncertainty, and lack of blind resend.
- [ ] Provide a reproducible isolated validation method for crash intervals, without requiring the user to time a process kill manually or risking their normal project sessions.
- [ ] The completed MVP supports an opt-in real-agent smoke scenario: planner requests work, coder replies and requests review, reviewer responds, and daemon restart preserves identities and message history. Deterministic automated tests do not rely on paid model calls or exact model wording.
- [ ] Both CLI acceptance tests and direct HTTP tests exercise retry contracts and observable recovery outcomes.

## Manual validation

- [ ] Use the supplied isolated scenario to interrupt delivery after input may have occurred; restart and verify uncertain status with no automatic resend.
- [ ] Attempt retry without duplicate acceptance and verify rejection; explicitly allow a duplicate and verify a new attempt with the original message ID and preserved history.
- [ ] Acknowledge a message and verify that further retry is rejected.
- [ ] Run the planner/coder/reviewer conversation, restart the daemon, and inspect surviving execution identities, replies, and unread messages.

## Completion gate

After automated checks pass, provide the isolated crash procedure and complete crew demonstration with expected outcomes. Stop for the user's final manual sign-off. No manual acceptance has been recorded.
