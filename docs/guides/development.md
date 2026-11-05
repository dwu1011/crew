# Development

Reviewed: 2026-10-06. Commands come from [package.json](../../package.json).

## Prerequisites and checks

Use Bun for dependencies and scripts. The package supports Node.js 22 or 24. Lifecycle and agent integration tests use tmux; running real seats additionally requires Claude Code on the executable path.

```sh
bun install
bun run build
bun run typecheck
bun run test
node dist/cli.js --help
```

The test script builds before running Vitest. CLI tests execute the compiled `dist/cli.js`. Real-agent validation is opt-in; ordinary tests use controlled native fixtures. Consult [test sources](../../test/agent.test.ts) and [historical validation commands](../../.scratch/crew-mvp/issues/09-recover-uncertain-retry.md) before running checks that use live model sessions.

## Documentation changes

Resolve local links relative to the document containing them. Keep specs, design rationale, and source references separate. Review documentation against relevant code when behavior changes. There is no `docs:check` command yet.

Use the [architecture map](../../ARCHITECTURE.md) to locate implementation files and the [knowledge index](../index.md) to locate related documents.
