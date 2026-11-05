# Per-seat capabilities

Status: complete. Branch: `feat/per-seat-capabilities`.

## Goal and scope

Allow legacy configurations and reusable profiles to select skills and MCP servers per seat. Omitted lists retain native inheritance; explicit empty lists disable discovery. Selected skills load on demand from immutable execution snapshots. Capture inspectable, secret-free capability summaries and include resolved material in the existing launch digest. Do not replace running executions after configuration changes.

Non-goals: additional runtimes, capability bundles, permission sandboxing, hot reload, plugin installation, and credential management.

## Dependencies and decisions

- Existing profile/project-run work was copied from the original checkout as an uncommitted baseline; that checkout remains untouched. A baseline snapshot is retained outside the repository.
- Claude Code 2.1.312 help and the [CLI reference](https://code.claude.com/docs/en/cli-reference) document `--disable-slash-commands`, `--mcp-config`, and `--strict-mcp-config`.
- Explicit skill lists disable native skill/command discovery and supply a small catalog for file-based lazy loading. Native slash-command invocation is unavailable in this mode.
- A top-level `mcp_config` references a native MCP JSON registry; seat `mcp_servers` lists select entries. Only selected server definitions enter private execution files. Inspection exposes names and digests, never commands, URLs, environment values, or headers.
- Explicit skill paths resolve relative to the definition. Bare names search `.claude/skills` and `.agents/skills` under the definition directory, then the same user directories. Skill resources are snapshotted and hashed with their instructions.
- Inherited capabilities are reported as inherited and unenumerated. Managed runtime policy still applies; configuration inspection does not attest successful server connections.

## Steps and acceptance

1. Resolve and validate all selected resources before creating executions or terminals. Reject unknown servers, invalid skills, and duplicate skill names.
2. Pass strict MCP flags and disable native skill discovery only when the corresponding list is explicit. Keep ordinary inherited launches unchanged.
3. Snapshot skill files and selected MCP config, record safe summaries per execution, and expose them in profile inspection, status, members, and execution history.
4. Prove distinct seat selections, explicit empty versus omitted behavior, lazy loading, source-change mismatch without replacement, snapshot/history durability, validation before launch, and secret redaction through automated tests.
5. Update existing usage and architecture docs, run build/typecheck/tests, and obtain independent code review.

## Progress and verification

- Baseline restored in the new worktree; native launch path and runtime switches inspected.
- Implemented selection resolution and validation, lazy skill snapshots, strict MCP configuration, safe summaries in profile/status/members/whoami/history, and migration `015_seat_capabilities`.
- `bun run typecheck`: passed.
- `bun run test`: passed, 100 tests passed and 3 opt-in native tests skipped (103 total). The build runs as part of this command.
- `bunx vitest run test/agent.test.ts -t 'invalid capability|independently preserve'`: passed, 2 tests. This also covers the additional independent-dimension regression introduced after the full suite started and strengthens profile inspection to require HTTP 400.
- `node dist/cli.js --help` and `git diff --check`: passed.
- Independent code review found one validation-error issue: profile register/show returned a generic HTTP 500 for invalid capabilities. Resolution errors now produce actionable HTTP 400 responses, verified by CLI and HTTP regression checks. No other actionable findings were reported.
- Deterministic fixtures cover distinct seat selections, omitted/empty lists independently, private file permissions, lazy catalogs, resource snapshots and executable bits, secret redaction, unchanged launch reuse, resource/server edit mismatch without replacement, daemon restart, revised profile launches, historical summaries, and invalid configuration before terminal creation. Existing upgrade checks verify historical capability summaries remain null.
- No real model sessions or live MCP connections were run. Native flags were checked against installed Claude Code 2.1.312 help and official documentation. Automated results prove launch wiring, not successful connections or advanced native skill semantics.

## Remaining questions

None blocking. Native runtime policy may reject strict configuration; Crew must report launch failure without falling back to inherited capabilities.
