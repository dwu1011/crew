# 05: Persist and inspect messages

**What to build:** Humans and managed agents can send durable messages to seats and inspect their full contents and pending delivery records, without requiring terminal submission yet.

**Blocked by:** 03: Launch and discover a complete crew (including manual acceptance).

**Status:** completed

- [x] Sending commits an immutable message and initial pending delivery attempt together before returning a stable message identifier.
- [x] Sender attribution comes from the authorized execution or human operator; unknown recipients, cross-crew access, and arbitrary sender impersonation are rejected.
- [x] Exactly one text or body-file input is required; body-file supports standard input and preserves Unicode, multiline content, and shell-sensitive characters literally.
- [x] Inbox lists unacknowledged incoming messages, with an all-history option. Message inspection shows full content, attribution, and delivery history without acknowledging receipt.
- [x] Stable submission request identities prevent duplicates on retries; conflicting reuse is rejected. Lost responses after commit can recover the original result.
- [x] Human callers can select crews explicitly. CLI JSON output is machine-readable, diagnostics remain on standard error, and persistence success is distinct from delivery readiness.
- [x] Stopped recipients do not cause accepted messages to be lost. This slice records pending delivery rather than claiming submission.
- [x] CLI and direct HTTP tests cover input handling, durable acceptance, scope, idempotency, and inspection across daemon restart.

## Manual validation

- [x] Send messages from an agent and a human shell, then inspect their sender attribution and pending state.
- [x] Send multiline content containing quotes, Unicode, backticks, and shell-like text; verify exact stored content without executing that text.
- [x] Restart the daemon and verify history remains; repeat one request identity and confirm the original message is returned.

## Automated verification

- Branch: `feat/ticket-5-durable-messages`; implementation commit `2b90684`.
- `bun run typecheck`: passed.
- Final `bun run test`: 45 passed, 1 opt-in native smoke test skipped. CLI and HTTP tests use a real daemon, SQLite, tmux, and controlled native executable fixtures.
- Standards and spec reviews compared against ticket 4's final commit `3522427`: no remaining findings. The baseline question was asked; `3522427` was used as the natural comparison point while the reply was pending.
- Ticket 4 PR: https://github.com/dwu1011/crew/pull/4, stacked on PR 3.
- No terminal submission, acknowledgment, or reply behavior is implemented by this slice. The user delegated the full native validation procedure, then approved PR creation and progression to ticket 6 on 2026-10-04.

## Completion gate

Provide the exact manual procedure after automated checks pass. Stop for user sign-off before beginning another ticket. Assisted native validation passed; the user approved progression on 2026-10-04. Evidence: `/private/tmp/crew-validation-5-zrdotf/validation-summary.json`. PR: https://github.com/dwu1011/crew/pull/5.

## Manual handoff

Historical ticket-5 procedure; its expected pending-only behavior applies to the ticket-5 branch. Ticket 6 adds terminal delivery. Run from the crew repository in the same shell. Fresh state gives the agents the updated coordination instructions.

```sh
bun run build
export CREW_HOME="$(mktemp -d /tmp/crew-manual-5.XXXXXX)"
bun run crew up examples/three-seat/crew.yaml --json
bun run crew attach --crew demo-crew
```

Finish native login/trust prompts. In planner's pane, ask the agent to run this command and report the returned message ID:

```sh
crew send coder --text 'Inspect the parser and report your findings.' --request-id planner-manual-5 --json
```

Expected: sender is planner with its execution ID; recipient is coder; delivery is pending. The coder does not receive automatic terminal input in this slice. Detach the crew view with Ctrl-a then d. In the human shell:

```sh
cat > "$CREW_HOME/body.txt" <<'BODY'
Unicode: café 雪
Quotes: 'single' "double"
Backticks: `echo literal`
Shell-like text: $(echo literal); $HOME
BODY
bun run crew send coder --crew demo-crew --body-file "$CREW_HOME/body.txt" --request-id human-manual-5 --json > "$CREW_HOME/sent.json"
cat "$CREW_HOME/sent.json"
message_id="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.env.CREW_HOME+"/sent.json","utf8")).id')"
bun run crew message show "$message_id" --crew demo-crew --json
bun run crew inbox --crew demo-crew --json
bun run crew inbox --crew demo-crew --all --json
```

Expected: the human sender is operator, body is unchanged, each message has one pending attempt, and acknowledgedAt stays null after inspection. Request IDs are scoped to crew and sender execution (or operator); inspection is available to the operator and participating seats. Operator inbox shows the selected crew; agent inbox shows that seat's incoming messages. All/history and unacknowledged views currently match because acknowledgment is a later slice.

Repeat the same human submission before and after daemon restart:

```sh
bun run crew send coder --crew demo-crew --body-file "$CREW_HOME/body.txt" --request-id human-manual-5 --json
bun run crew daemon stop
bun run crew daemon start
bun run crew send coder --crew demo-crew --body-file "$CREW_HOME/body.txt" --request-id human-manual-5 --json
bun run crew message show "$message_id" --crew demo-crew --json
```

Expected: the same message ID and one pending attempt. The CLI prints the submission request ID to stderr before sending, so it remains available after a lost response. Recover by repeating that ID with identical recipient and body under the same sender identity.

These commands must fail without adding messages:

```sh
bun run crew send coder --crew demo-crew --text 'Changed body.' --request-id human-manual-5 --json
bun run crew send missing --crew demo-crew --text 'Unknown recipient.' --json
bun run crew send coder --crew demo-crew --json
bun run crew send coder --crew demo-crew --text 'Two sources.' --body-file "$CREW_HOME/body.txt" --json
```

Check stdin and stopped recipients:

```sh
bun run crew send reviewer --crew demo-crew --body-file - --request-id stdin-manual-5 --json < "$CREW_HOME/body.txt"
bun run crew down --crew demo-crew --json
bun run crew send coder --crew demo-crew --text 'Persist while stopped.' --request-id stopped-manual-5 --json
bun run crew inbox --crew demo-crew --all --json
bun run crew daemon stop
```

Expected: stdin preserves the exact body. Sending to a stopped seat succeeds with pending delivery. History survives; no submission or receipt is claimed. Cleanup stops the crew and daemon. Assisted validation completed and progression to ticket 6 was approved.
