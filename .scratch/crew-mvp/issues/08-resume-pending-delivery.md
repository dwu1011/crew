# 08: Resume pending delivery when recipients become available

**What to build:** Messages sent while a recipient is stopped or the coordinator restarts remain available and are submitted once a confirmed current execution becomes ready.

**Blocked by:** 04: Manage crew lifecycle without duplicate executions; 06: Deliver full messages into agent terminals (both including manual acceptance).

**Status:** ready-for-agent

- [ ] Messages addressed to stopped seats remain pending and are considered when the seat is launched again through supported crew startup.
- [ ] Daemon restart reconciles executions before processing pending deliveries; confirmed surviving executions retain their identities and generations.
- [ ] Pending attempts recover from persisted state rather than relying on lost in-memory queues.
- [ ] Attempts identify the execution actually targeted; an execution change before input prevents delivery to a stale pane and requires a fresh resolution.
- [ ] Submitted attempts are not automatically resubmitted merely because a recipient relaunched.
- [ ] Crew shutdown suspends its eligible delivery without deleting messages; daemon shutdown preserves terminal execution and outstanding records.
- [ ] CLI and direct HTTP tests cover stopped recipients, restart after persistence but before input, generation changes, and duplicate suppression for submitted messages.

## Manual validation

- [ ] Stop a crew, persist a message to a seat, relaunch the crew, and observe delivery to the new execution with the same message ID.
- [ ] Persist pending work while input is unsafe, restart the daemon, make the recipient ready, and verify eventual submission.
- [ ] Restart after a successful submission and verify that the message does not appear again automatically.

## Completion gate

Provide exact steps, expected identities, and delivery outcomes after automated checks pass. Stop and wait for explicit manual acceptance. No manual acceptance has been recorded.
