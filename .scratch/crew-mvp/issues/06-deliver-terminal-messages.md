# 06: Deliver full messages into agent terminals

**What to build:** A saved message reaches the recipient's existing native conversation as full text, with safe terminal handling and observable submission outcomes.

**Blocked by:** 05: Persist and inspect messages (including manual acceptance).

**Status:** ready-for-agent

- [ ] A delivery worker resolves the current recipient execution and waits for a supported ready-input condition without blocking the send request indefinitely.
- [ ] Permission dialogs, selection menus, existing drafts, and unknown readiness defer injection with inspectable reasons.
- [ ] Sends to one seat are serialized. Execution, generation, and the observed pane are revalidated immediately before input.
- [ ] Submitting is persisted before the first input-affecting action. Full message envelopes include sender, recipient, stable message ID, body, and reply guidance.
- [ ] Terminal integration uses safe process arguments or private input files, a tmux buffer, and separate submission; message content is not interpolated into shell commands.
- [ ] Attempt history distinguishes pending, submitting, submitted, definite failure, and uncertainty. Submission does not claim recipient acknowledgment or task completion.
- [ ] Definite pre-input failure is distinguished from failure after input may have occurred. No automatic retry duplicates an uncertain submission.
- [ ] CLI and HTTP observations plus controlled terminal tests verify deferral, serialization, exact payload delivery, and stale-target prevention.

## Manual validation

- [ ] Send to a ready agent and observe the entire envelope in its native terminal; inspect submitted status without acknowledgment.
- [ ] Create an existing input draft and verify the message remains pending rather than overwriting it; clear the draft and verify delivery becomes possible.
- [ ] Send two messages close together and confirm distinct, noninterleaved envelopes with preserved bodies.

## Completion gate

Present a runnable native-terminal demonstration and expected results after automated checks pass. Stop and await explicit manual acceptance. No manual acceptance has been recorded.
