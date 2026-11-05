# Project knowledge

This directory holds durable project knowledge: requirements, rationale, plans, operational guidance, and inspiration sources. Runtime coordination data remains in the daemon state directory.

| Question | Read |
| --- | --- |
| How should an agent work here? | [AGENTS.md](../AGENTS.md) |
| What does the current system look like? | [Architecture](../ARCHITECTURE.md) |
| What do the domain terms mean? | [Vocabulary](../CONTEXT.md) |
| What should Crew do? | [Product specs](product-specs/index.md) |
| Why was a design chosen? | [Design docs](design-docs/index.md) |
| What inspired it? | [References](references/index.md) |
| What work is planned or verified? | [Execution plans](exec-plans/index.md) |
| How do I build and check it? | [Development](guides/development.md) |
| How do I launch and recover it? | [Operations](guides/operations.md) |

## Maintenance

Give new specs and design docs an explicit status: draft, accepted, implemented, or superseded. Link to related code, plans, and sources. A spec's acceptance does not establish implementation or verification.

Keep each fact in one authoritative document and link to it elsewhere. Record conversation decisions when they affect future work. Update current guidance alongside behavior changes; retain historical verification evidence with its original limitations.

Existing root specs and `.scratch` ticket records remain in place and are indexed here. New artifacts belong in the corresponding `docs/` section. Do not duplicate their full contents.
