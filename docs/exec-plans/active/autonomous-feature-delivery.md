# Autonomous feature delivery implementation

Status: active. Started 2026-11-05.

## Goal and scope

Implement the [delivery specification](../../product-specs/autonomous-feature-delivery.md) in its section 16 order. The user's request to implement authorizes product changes; external commits, pushes, merges, and deployment are not authorized. Preserve the pre-existing uncommitted work. One writer at a time.

## Sequence and acceptance

- [ ] 1. Durable bounded tasks: CLI/HTTP create/inspect, strict contracts, execution planning grants, transactional events and request deduplication, version fencing, shutdown/restart retention. Invalid advancement must reject.
- [ ] 2. Owned stage attempts: claims, leases, capacity reservations, assignment inbox, handoffs.
- [ ] 3. Recovery: process/resource reconciliation and dispatch disable through shutdown.
- [ ] 4. Independent review/repair loop: immutable evidence, independence, retry accounting.
- [ ] 5. Autonomous intake: bounded planner dispatch and focused intent questions.
- [ ] 6. Reviewed plan revisions and invalidation.
- [ ] 7. Dependency/capacity scheduler, groups, budgets and forecasts.
- [ ] 8. Isolated workspace launch and pinned dependency composition.
- [ ] 9. Independently checked integration candidates.
- [ ] 10. Journaled GitHub merge boundary.
- [ ] 11. Pilot deployment, running verification and recovery.

Each slice uses the observable acceptance scenarios in section 16. Parallel writers stay disabled until slice 8. No slice is considered complete merely because its schema exists.

## Decisions and boundaries

Implement slice 1 with named operations, not a generic state setter. Initially only small-route contracts may enter ready; standard/investigative activation waits for reviewed plans in slice 6. Planning grants are feature-scoped and execution-bound, issued/revoked by the operator. Role names grant no authority. Task controls preserve stage. No agent work is dispatched in slice 1.

The pilot deployment destination, concrete release authority, and actual production resource limits remain open. They do not block task storage. Native-agent acceptance and external-provider acceptance remain separate from fixtures.

## Verification and progress

Implementation in progress. Required checks: build, typecheck, public CLI/HTTP tests with isolated state, migration/retention checks, and independent code review. Record actual results here before marking a slice complete.
