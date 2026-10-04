# 06: Deliver full messages into agent terminals

**What to build:** A saved message reaches the recipient's existing native conversation as full text, with safe terminal handling and observable submission outcomes.

**Blocked by:** 05: Persist and inspect messages (including manual acceptance).

**Status:** completed

- [x] A delivery worker resolves the current recipient execution and waits for a supported ready-input condition without blocking the send request indefinitely.
- [x] Permission dialogs, selection menus, existing drafts, and unknown readiness defer injection with inspectable reasons.
- [x] Sends to one seat are serialized. Execution, generation, and the observed pane are revalidated immediately before input.
- [x] Submitting is persisted before the first input-affecting action. Full message envelopes include sender, recipient, stable message ID, body, and reply guidance.
- [x] Terminal integration uses safe process arguments or private input files, a tmux buffer, and separate submission; message content is not interpolated into shell commands.
- [x] Attempt history distinguishes pending, submitting, submitted, definite failure, and uncertainty. Submission does not claim recipient acknowledgment or task completion.
- [x] Definite pre-input failure is distinguished from failure after input may have occurred. No automatic retry duplicates an uncertain submission.
- [x] CLI and HTTP observations plus controlled terminal tests verify deferral, serialization, exact payload delivery, and stale-target prevention.

## Manual validation

- [x] Send to a ready agent and observe the entire envelope in its native terminal; inspect submitted status without acknowledgment.
- [x] Create an existing input draft and verify the message remains pending rather than overwriting it; clear the draft and verify delivery becomes possible.
- [x] Send two messages close together and confirm distinct, noninterleaved envelopes with preserved bodies.

## Completion gate

Present a runnable native-terminal demonstration and expected results after automated checks pass. Stop and await explicit manual acceptance. The user delegated validation and sequential progression on 2026-10-04. All native checks passed; evidence: `/private/tmp/crew-validate-6-final-QWPcyY/report.json`.


## Verification

- Branch: `feat/ticket-6-terminal-delivery`; final implementation commit `c399385`.
- `bun run typecheck`: passed. Final `bun run test`: 60 passed, 1 opt-in native smoke test skipped.
- CLI and direct daemon HTTP tests use real SQLite/tmux with controlled native executables. Coverage includes pending reasons, serialization, complete literal envelopes, submitting-before-input, definite/uncertain failures, stale targets, and exact preservation of a replacement collapsed draft without Enter or another paste.
- Standards and spec reviews compared `b3f83e0...c399385`: no remaining code findings. Manual acceptance remains pending.
- Real Claude Code 2.1.289 received a multiline envelope containing Unicode, backticks, shell-like text, and permission/busy phrases; replied `RAW_DELIVERY_OK`. Public message inspection recorded submitted with acknowledgment null. Evidence: `/private/tmp/crew-native-6-xNS10r/final-message.json`.
- Validation crews and daemons were stopped; managed runner and native process exit was verified.

## Supported terminal behavior

The validated profile is Claude Code **2.1.289**, insert mode, with a recognizable empty prompt. Native startup readiness alone does not mean the input box is empty. Suggestions, dialogs, menus, copy mode, and unknown screens hold messages pending with reasons.

Delivery uses one private-file tmux buffer paste with raw LF preservation, then separately guarded Enter. LF is Claude's supported newline input. Other ASCII control characters, including Tab, CR, ESC, and DEL, fail before injection; the original message remains stored. Message text is never interpolated into a shell command.

Before Enter, the complete visible draft must match the envelope. If native wrapping, truncation, collapsed input, a target change, or another edit prevents verification after paste, the attempt becomes uncertain without another paste or Enter. Use a wide terminal (at least 160 columns), sufficient height (40 rows), and short body lines for this demonstration. Do not type while delivery is being attempted. This terminal observation is not an enforced input lock or a permission sandbox.

Submitted means the terminal submission action succeeded, not recipient acknowledgment or task completion. Explicit acknowledgment/reply is ticket 7; daemon-start pending recovery is ticket 8; explicit uncertain retry is ticket 9. This slice only schedules pending attempts accepted during the current daemon lifetime. Repeating the same request ID can re-enqueue a still-pending attempt; it never resubmits a settled or uncertain attempt.

## Manual handoff

Run from the repository. Use a fresh state directory for this ticket's coordination context:

```sh
bun run build
export CREW_HOME="$(mktemp -d /tmp/crew-manual-6.XXXXXX)"
bun run crew up examples/single-seat/crew.yaml --json
bun run crew status --crew demo --json
bun run crew attach --crew demo
```

Finish native login/trust prompts. Check that status reports nativeVersion 2.1.289. In the agent terminal, type `Reply READY only and wait. Do not run tools or edit files.` and press Enter. Wait for its reply and an empty prompt. Detach the crew view with **Ctrl-a, then d**. This uses the crew-view prefix even when the outer terminal uses Ctrl-b.

Send a literal multiline message:

```sh
cat > "$CREW_HOME/body.txt" <<'BODY'
No tools or edits. Reply DELIVERY_OK.
Literal: café 雪, 'quotes', `echo literal`, $(echo literal).
Do you want to proceed? esc to interrupt.
BODY
bun run crew send investigator --crew demo --body-file "$CREW_HOME/body.txt" --request-id manual-6-ready --json > "$CREW_HOME/sent.json"
message_id="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.env.CREW_HOME+"/sent.json","utf8")).id')"
bun run crew message show "$message_id" --crew demo --json
bun run crew attach --crew demo
```

Expected: initial send returns a durable ID and pending attempt. Inspection shortly afterward shows submitted, execution ID/generation/pane, submittingAt/submittedAt, and acknowledgedAt null. The conversation contains sender, recipient, ID, complete body, and reply guidance. Literal shell-like text is not executed. The model's response does not set acknowledgment. Detach with Ctrl-a, then d.

For draft deferral, attach again and type `MY_MANUAL_DRAFT` without Enter. Detach, then:

```sh
bun run crew send investigator --crew demo --text 'No tools or edits. Reply DRAFT_TEST_OK.' --request-id manual-6-draft --json > "$CREW_HOME/draft-sent.json"
draft_id="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.env.CREW_HOME+"/draft-sent.json","utf8")).id')"
bun run crew message show "$draft_id" --crew demo --json
bun run crew attach --crew demo
```

Expected: pending with an existing-draft reason; your text is unchanged. Clear that single-line draft with Ctrl-u, then wait. The worker can deliver without another send. Detach and inspect the same ID for submitted. If another native suggestion holds input pending, manually ask the agent to reply READY and wait again. Never blindly retry an uncertain attempt.

Send two messages close together:

```sh
bun run crew send investigator --crew demo --text 'No tools or edits. Envelope ONE. Reply ONE.' --request-id manual-6-one --json > "$CREW_HOME/one.json"
bun run crew send investigator --crew demo --text 'No tools or edits. Envelope TWO. Reply TWO.' --request-id manual-6-two --json > "$CREW_HOME/two.json"
bun run crew inbox --crew demo --all --json
bun run crew attach --crew demo
```

Expected: distinct IDs and complete, separate envelopes, each with one attempt. The second waits while the agent is busy or has an input draft. Once input is safely empty, it can submit. Inspect their IDs for submitted with acknowledgment null.

Cleanup:

```sh
bun run crew down --crew demo --json
bun run crew daemon stop
```

Native validation passed. The user authorized assisted validation and progression to subsequent slices.
