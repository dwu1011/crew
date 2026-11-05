# Native prompt normalization mismatch

Date: 2026-10-08. Status: fix implemented and verified with focused tests; changes remain uncommitted. See the [messaging design](../../design-docs/durable-messaging.md) for the accepted comparison rule and the [operations guide](../../guides/operations.md#prompt-hook-mismatch) for recovery.

## Symptom and local evidence

Claude displayed:

```text
UserPromptSubmit operation blocked by hook:
  Submitted prompt does not match the saved Crew delivery.
```

Two inspected planning-crew attempts were `uncertain`, with failure `Native submitted prompt did not match the persisted delivery; hook blocked processing`. Both saved message bodies ended in a newline. The recipient runtime was Claude Code 2.1.293. Runtime credentials, message bodies, and database files are intentionally excluded from this record.

## Reproduction and diagnosis

An isolated temporary tmux session ran real Claude Code with a diagnostic UserPromptSubmit hook. The hook captured its input and blocked model processing. The experiment did not require a model response or change native permission settings.

- A multiline 715-character envelope arrived at the hook with 714 characters after removing Claude's recognized paste wrapper. The missing character was its final newline.
- A separate short prompt ending in a space, tab, and two newlines arrived without that trailing whitespace and without a paste wrapper.
- This established native trimming as a sufficient cause. Terminal corruption and stale delivery markers were considered, but neither was needed to reproduce the failure.
- The first regression setup included a tab, which Crew rejects before terminal input. Removing that unsupported control character exposed the actual mismatch: the attempt became `uncertain` instead of `submitted`.

The temporary diagnostic session and capture files were removed after diagnosis.

## Fix and boundaries

[DeliveryAttempts.verifyPrompt](../../../src/delivery-attempts.ts) now accepts the original saved envelope or its fully trailing-trimmed form after the existing paste-wrapper handling. It does not rewrite the saved message body or relax execution, generation, recipient, timestamp, or replay checks.

The regression exercises the real CLI, daemon HTTP interface, SQLite, tmux, and controlled native fixture. Both wrapped and plain prompt variants must submit successfully while retaining the literal stored body and leaving acknowledgment unset. Modified internal spaces, removed indentation, added text, and unexpected appended whitespace must still fail verification.

## Verification evidence

```sh
bun run build
bun run typecheck
bunx vitest run test/agent.test.ts \
  -t 'native trailing whitespace trimming|native receipts enforce|delivery records native|post-paste|delayed native hook'
git diff --check
```

The focused regression first failed with `uncertain` where `submitted` was expected. After the fix, nine selected cases passed in about 20 seconds. Typecheck, build, and whitespace checks passed. Code review found no actionable issues in the scoped fix.

These checks cover normalization, receipt identity and replay, separation from acknowledgment, post-paste input changes, and delayed-hook protection. The complete test suite was not rerun for this patch. The real native diagnostic established normalization behavior; successful end-to-end model handling of the user's two messages was not claimed.

## Loading the fix and recovery

The compiled program was rebuilt and the affected coordinator was stopped and restarted to load the updated verifier. Stopping the coordinator does not itself stop managed agent terminals. No existing failed or uncertain delivery was automatically retried or marked successful.

Previously uncertain attempts retain their history. Inspect them before requesting an explicit retry; uncertain retry requires accepting possible duplicate delivery. A missing or unverified terminal still requires the existing lifecycle recovery procedure.

This incident is separate from the Claude auto-mode classifier's earlier Data Exfiltration rejection of `crew reply`, recorded in the [project-runs validation](../active/project-runs.md). Normalizing hook input does not change native tool permissions or resolve that rejection.

## Conversation reset identity mismatch

On 2026-10-08 the user reported another `Crew could not verify this delivery` hook error and confirmed using `/clear` or resume. This was a separate identity problem, not trailing whitespace. The affected run had already been stopped and cleared during investigation, so its original exception was unavailable.

An isolated real Claude experiment verified a long message without clearing (HTTP 200), then reproduced HTTP 403 `Native prompt identity mismatch` after `/clear`. Crew still expected the launch-time session ID, while Claude supplied a new conversation ID. The hook swallowed that HTTP exception and displayed the generic error.

The fix separates current conversation identity from the immutable process launch receipt, handles clear/resume SessionStart hooks, verifies ownership and cwd, and rejects stale session events. HTTP errors now include status and reason; timeouts are identified explicitly. Session transition requests allow eight seconds for bounded process inspection within the ten-second hook limit.

After the fix, the isolated real Claude `/clear` reproduction returned HTTP 200 and marked the delivery submitted. The final diagnostic hook deliberately blocked model handling after verification. An initial diagnostic wrapper emitted two JSON objects on its failure path, which Claude rejected as invalid hook output; that setup was corrected before the post-fix verification. Validation-owned crews were shut down. Existing operator crews were not relaunched or automatically retried.

Focused CLI/HTTP regression checks passed for clear/resume delivery, stable execution/generation, daemon restart, stale identity rejection, and diagnostic errors, alongside receipt and delayed-hook checks. Code review found no blockers.

Final focused clear/resume regression after restoring startup’s original marker-before-ready ordering: 2 passed in 4.30 seconds. Build, typecheck, and whitespace checks passed. Both code/spec reviews found no blockers. The existing hands-on daemon was restarted and migrated to schema 013; its crew remained stopped so the next launch installs the new hooks.

Full-suite validation is not green: the first run had 88 passed, 9 failed, 3 skipped; a rerun with idle sleep prevention had 90 passed, 7 failed, 3 skipped. Failures included terminal ownership checks and timeouts across existing delivery/recovery cases. A later mixed focused run passed 5 and failed 2 (startup process-inspection timeout and waiting for an uncertain attempt); the new diagnostic did report the expected HTTP 403 before its timeout assertion failed. Some 25-second tests took over 80 seconds, and host inspection showed load average 52.67 with 15 GB used and 208 MB unused. Host pressure may contribute, but the broader failures remain unresolved and are not counted as passed.
