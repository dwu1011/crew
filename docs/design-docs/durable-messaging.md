# Durable messaging

Status: implemented in the MVP, with a native normalization fix in the working tree. Reviewed: 2026-10-08.

## Problem and approach

Terminal submission can fail or be interrupted after input has already changed. Crew must preserve accepted messages and distinguish persistence, submission, receipt, and task completion.

The daemon commits a message and pending delivery attempt before touching terminal input. Attempts retain their own target execution and outcome. Native prompt evidence confirms submission; explicit acknowledgment or a linked reply records receipt. Neither proves that requested work is complete.

## Tradeoffs and recovery

Treating successful terminal input as completed work would overstate the evidence. Blindly retrying interrupted submission can duplicate a request. Crew instead preserves uncertain attempts and requires `--allow-duplicate` for an explicit retry. Definite failures can receive a new attempt without rewriting prior history.

This keeps uncertainty visible to the operator and avoids promising exactly-once terminal delivery. Pending work waits for verified execution ownership and safe input conditions rather than overwriting a draft or answering a permission prompt.

## Explicit history clearing

On 2026-10-08 the user changed the retention policy: successful `crew down` clears that crew’s messages and delivery attempts after its agents stop. Failed shutdown preserves messages. `crew message clear` provides operator-only clearing while agents remain running. Both paths serialize with terminal delivery and remove private submission artifacts. Execution history and other crews are preserved. Clearing saved history does not remove existing native conversation text or drafts.

Durability applies across daemon restart and delivery failures until an explicit clear or successful crew shutdown. Messages sent after shutdown can still wait for the next launch. This supersedes the original specs’ message-retention promises across explicit crew shutdown.

## Native prompt normalization

Claude Code 2.1.293 removes trailing whitespace before calling the prompt hook, including the final newline in a pasted message. Reproducing this with an isolated native hook showed a 715-character envelope arriving as 714 characters. Short unwrapped prompts also lost trailing whitespace. Exact-only verification incorrectly blocked these deliveries.

Verification accepts either the exact saved envelope or its fully trailing-trimmed form after removing Claude's recognized paste wrapper. Stored message bodies remain literal. Internal whitespace edits, added text, execution identity mismatches, and receipt replays retain their existing rejection behavior. The CLI/HTTP regression covers wrapped and unwrapped normalized prompts.

This is deliberately narrower than trimming both sides, collapsing whitespace, or disabling the hook. A partially trimmed payload or newly added whitespace is not accepted unless it exactly matches one of the two permitted forms. The stored verification hash describes the accepted unwrapped native prompt, which can differ from the full saved envelope at its trailing whitespace. Verification still establishes submission rather than acknowledgment or task completion.

## Conversation identity

A managed execution identifies the launched process; Claude can replace its conversation during `/clear` or resume. The immutable launch session stays in the process receipt and `executions.native_session_id`. Migration 013 adds nullable `conversation_session_id`, falling back to launch identity for existing executions. Current status and authentication use the active conversation; historical execution records retain the launch session ID.

Authenticated clear/resume SessionStart hooks register a new conversation only after exact working-directory and live process ownership checks. The hook then atomically replaces its readiness marker. Delivery requires that marker to match the current conversation, and checks the conversation binding again before terminal submission completes. A transition interrupted before marker update defers delivery rather than bypassing verification. Old conversation prompt/activity events remain invalid.

## Evidence and sources

- [MVP implementation decisions](../../crew-mvp-spec.md).
- [Message handling](../../src/messages.ts) and [delivery attempts](../../src/delivery-attempts.ts).
- [Recovery and validation evidence](../../.scratch/crew-mvp/issues/09-recover-uncertain-retry.md).
- [Native normalization incident and validation](../exec-plans/completed/native-prompt-normalization.md): reproduction, regression commands, deployment, and limits.
- [OpenRig reference](../references/openrig.md): recorded prior art, with upstream provenance still to be captured.
