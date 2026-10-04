# 05: Persist and inspect messages

**What to build:** Humans and managed agents can send durable messages to seats and inspect their full contents and pending delivery records, without requiring terminal submission yet.

**Blocked by:** 03: Launch and discover a complete crew (including manual acceptance).

**Status:** ready-for-agent

- [ ] Sending commits an immutable message and initial pending delivery attempt together before returning a stable message identifier.
- [ ] Sender attribution comes from the authorized execution or human operator; unknown recipients, cross-crew access, and arbitrary sender impersonation are rejected.
- [ ] Exactly one text or body-file input is required; body-file supports standard input and preserves Unicode, multiline content, and shell-sensitive characters literally.
- [ ] Inbox lists unacknowledged incoming messages, with an all-history option. Message inspection shows full content, attribution, and delivery history without acknowledging receipt.
- [ ] Stable submission request identities prevent duplicates on retries; conflicting reuse is rejected. Lost responses after commit can recover the original result.
- [ ] Human callers can select crews explicitly. CLI JSON output is machine-readable, diagnostics remain on standard error, and persistence success is distinct from delivery readiness.
- [ ] Stopped recipients do not cause accepted messages to be lost. This slice records pending delivery rather than claiming submission.
- [ ] CLI and direct HTTP tests cover input handling, durable acceptance, scope, idempotency, and inspection across daemon restart.

## Manual validation

- [ ] Send messages from an agent and a human shell, then inspect their sender attribution and pending state.
- [ ] Send multiline content containing quotes, Unicode, backticks, and shell-like text; verify exact stored content without executing that text.
- [ ] Restart the daemon and verify history remains; repeat one request identity and confirm the original message is returned.

## Completion gate

Provide the exact manual procedure after automated checks pass. Stop for user sign-off before beginning another ticket. No manual acceptance has been recorded.
