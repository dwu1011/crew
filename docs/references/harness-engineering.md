# Harness engineering

Status: reference for Crew's knowledge structure.

Source: [OpenAI, Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/), published 2026-02-11. Discussed for Crew on 2026-10-06.

## Useful ideas

The article describes a short agent entry point linked to structured repository documentation. Plans and decisions remain versioned and discoverable. Automated checks and periodic review help keep the knowledge useful as the implementation changes.

## Crew adaptations

Crew uses [AGENTS.md](../../AGENTS.md) as its entry point, an [architecture map](../../ARCHITECTURE.md), and sections for product specs, designs, execution plans, guides, and references. Existing specs and ticket evidence remain authoritative and are linked from the indexes.

Agents read linked documents according to their assignment. Runtime message and execution data remains in SQLite and private daemon files.

## Deferred ideas

The current documentation change does not introduce documentation CI, a recurring gardening agent, quality scores, or the article's full architectural enforcement system. Those are possible later tasks with their own scope and verification.
