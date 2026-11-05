# Working in Crew

Crew coordinates native agents in named seats, with durable messaging and managed terminal executions. Start with this map and read only the documents relevant to the task.

## Project knowledge

- [Knowledge index](docs/index.md): document purposes and maintenance rules.
- [Architecture](ARCHITECTURE.md): current code map, storage, and main flows.
- [Vocabulary](CONTEXT.md): crew, seat, execution, generation, and delivery terminology.
- [Product specs](docs/product-specs/index.md): intended behavior and scope.
- [Design docs](docs/design-docs/index.md): design rationale and significant decisions.
- [References](docs/references/index.md): projects, plugins, and articles that influenced Crew.
- [Execution plans](docs/exec-plans/index.md): current work and historical verification.
- [Development](docs/guides/development.md) and [operations](docs/guides/operations.md): setup, checks, and lifecycle commands.

## Working rules

- Read existing files before editing. Keep changes limited to the request.
- Use Bun for JavaScript/TypeScript work and uv for Python work.
- Preserve other work in progress. Only one Crew seat should write project files at a time.
- Do not commit, push, skip hooks, or amend published commits unless explicitly asked.
- Confirm risky or irreversible actions with the user first.
- Use concise, direct prose. No emojis unless requested.
- Avoid speculative abstractions and error handling. Delete unused code rather than commenting it out.
- Do not add comments, docstrings, or type annotations to untouched code.
- Run checks appropriate to the change. See the development guide for prerequisites.

## Maintaining knowledge

- Update relevant docs when a change alters documented behavior.
- Keep intended behavior in specs and observed implementation in architecture and guides.
- Record durable decisions in design docs, with links to their evidence and sources.
- For substantial work, maintain a plan with scope, acceptance criteria, progress, and verification evidence. Move it to completed only when its criteria are met.
- Preserve historical acceptance records; do not infer a passed manual check from permission to proceed.
- Reference documents describe inspiration. They do not introduce Crew requirements by themselves.
- Keep runtime credentials, execution files, and SQLite data outside this knowledge base.

## Commands

```sh
bun install
bun run build
bun run typecheck
bun run test
node dist/cli.js --help
```

Crew loads root `AGENTS.md` and `CLAUDE.md` into launch context when present. Linked documents are read on demand. Root guidance contributes to the launch configuration digest; edits can cause a later launch to report a configuration mismatch. Do not replace running executions automatically to resolve it.
