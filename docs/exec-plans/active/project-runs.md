# Reusable profiles and project runs

Scope: [issue #14](https://github.com/dwu1011/crew/issues/14) and the [spec](../../../crew-project-runs-spec.md). Review baseline: `a048e89`. Changes remain uncommitted.

## Acceptance and progress

- [x] Ship the planning profile and register/list/inspect custom profiles through CLI and HTTP.
- [x] Bind reusable roles to canonical project roots with isolated crews, seats, executions, and credentials.
- [x] Resolve operator commands from project context; preserve explicit crew and managed credential selection.
- [x] Reuse concurrent launches, reject invalid configurations before terminal creation, and retain legacy launch behavior.
- [x] Apply revised profiles only after verified shutdown; preserve historical roles, retired seats, messages, and generations.
- [x] Complete deterministic regression checks.
- [ ] Complete native planning linked-reply validation under operator-approved Claude permissions.
- [x] Complete standards and spec review and resolve findings.

## Verification evidence

Tests use the public CLI and daemon HTTP interface, as confirmed by the user. Deterministic checks use real SQLite and tmux with a controlled native fixture.

- Full regression: 88 passed, 3 opt-in native checks skipped. Final typecheck and focused checks after the last changes passed, including project-relative seat directories, state isolation, managed launch authorization, and HTTP error contracts.
- Concurrent profile-registration regression reproduced two successful conflicting registrations. A transactional conflict check fixes it; the focused test passes.
- A shutdown-versus-project-lookup regression pauses filesystem resolution, stops the crew, then resumes the request. The revoked sender receives 401 and persists no message.
- Standards and spec review found no remaining issues after the fixes. Review also checked canonical selectors, run identity, lifecycle history, retired seats, and compatibility.
- Native planning validation launched all three seats with Claude Code 2.1.291 and delivered the correct project guidance to planner. Planner attempted the linked reply, but Claude's auto mode classifier denied it as Data Exfiltration. The check failed; no permission policy was changed or blocked action retried. Restart assertions were subsequently moved before the reply check for future runs; that revised native check has not been rerun.

Only validation-owned temporary state and terminals are cleaned up. Existing operator runs remain untouched.

## Retention policy amendment, 2026-10-08

The user subsequently requested automatic message clearing on successful `crew down`, plus immediate clearing of the current planning run. This supersedes the earlier message-history acceptance criterion across explicit shutdown; execution and role history remain retained. `crew message clear` provides operator-only clearing without stopping agents. Five saved messages were cleared from the active planning run; its agents were left running. Earlier validation records above describe the prior policy.

Focused CLI/HTTP checks passed for scoped deletion including linked replies, repeated shutdown, preserved execution history and other crews, and live clearing with authorization and draft preservation. Code review found no blockers.

Full regression after the amendment: `bun run test` passed 94 tests; 3 opt-in native checks were skipped. `bun run typecheck` and `git diff --check` passed. Failed-shutdown regressions confirm saved messages remain available when process exit cannot be verified. The active planning run’s inbox was verified empty after clearing.
