# Operations

Reviewed: 2026-10-08. Run commands from the repository root after `bun run build`. See [development prerequisites](development.md).

## Inspect and launch

```sh
node dist/cli.js daemon start
node dist/cli.js daemon status --json
node dist/cli.js up examples/three-seat/crew.yaml --json
node dist/cli.js status --crew demo-crew --json
node dist/cli.js members --crew demo-crew --json
```

The example launches real Claude Code seats. Review its [configuration](../../examples/three-seat/crew.yaml) and role files before using it. The state directory defaults to `~/.crew`; use the global `--state-dir <directory>` option before the command to isolate an instance.

## Reusable planning profiles

With the global command installed, run these from a project folder:

```sh
crew profile list
crew profile show planning
crew up --profile planning
crew status
crew attach
crew send planner --text 'Help me plan this project. My goal is ...'
crew detach
crew down
```

The bundled profile contains planner, architect, and critic roles that wait for a brief. Each project gets separate agents, credentials, and message history. Launching the same profile in the same canonical folder reuses its run. `--project <directory>` overrides the current folder. Project-aware commands also work from subdirectories, selecting the deepest bound project root. Use `--profile` when several profiles exist there, or `--crew <name>` to operate a run explicitly from anywhere.

Register custom profiles once with `crew profile register /path/to/profile.yaml`. Their YAML contains `name` and `agents`, using the same runtime and role-file fields as legacy configurations, but omits `project`. Role files resolve relative to the profile definition; optional seat `cwd` paths resolve within the selected project. The daemon retains the source reference, so later edits are read at launch. Revised content applies only after verified crew shutdown; live instructions and historical context remain intact. Profile registrations are isolated by state directory.

HTTP operators can list/inspect/register through `GET /profiles`, `GET /profiles/:name`, and `POST /profiles` with an absolute `source`. `POST /crews/up` accepts either absolute `configPath` or `profile` plus absolute `project`. Existing status, members, and messaging interfaces accept optional `crew`, `profile`, and absolute `project` selectors. Managed credentials remain scoped to their own crew. Older HTTP callers without selectors retain their existing selection behavior.

## Messages and recovery

```sh
node dist/cli.js send coder --crew demo-crew --text 'Inspect the project and report findings.' --json
node dist/cli.js inbox --crew demo-crew --all --json
node dist/cli.js message show <message-id> --crew demo-crew --json
node dist/cli.js message retry <message-id> --crew demo-crew --json
```

Retry only after inspecting the attempt history. An uncertain outcome requires `--allow-duplicate` because input may already have been submitted. Managed recipients use `ack` or `reply` to acknowledge; submission evidence and acknowledgment do not prove completion. See [messaging rationale](../design-docs/durable-messaging.md).

### Messages pending behind prompt suggestions

If a delivery stays `pending` with `Existing input draft or suggestion cannot be confirmed empty`, inspect the recipient terminal. Claude may display `Try "..."` placeholder text even when no human has entered a draft. Crew deliberately treats visible input as potentially authored text rather than overwriting it.

Managed launches now set `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`. An isolated Claude Code 2.1.294 startup confirmed that this removes the placeholder. Existing native processes retain their launch environment; restarting only the daemon does not apply this setting to them. Applying it requires explicitly shutting down and relaunching the crew, which ends the current native conversations and clears saved messages. Resend any requests you still need after relaunch. Daemon restart alone preserves messages: pending deliveries resume when their recipient is safely ready; uncertain deliveries still need explicit retry.

The targeted regression reproduces a pending message when the daemon enables suggestions, then verifies that managed launch overrides that setting and submits the message. Nine focused checks covering suggestions, drafts, permission prompts, activity, and trailing normalization passed. The input guard itself remains unchanged.

### Conversation reset and resume

Claude’s `/clear` and resume operations can change its native conversation ID without replacing the agent process. Crew now registers these SessionStart events and tracks the current conversation separately from launch identity. Execution identity and generation stay stable; prompt and activity events from the previous conversation are rejected. The working directory must still match, and the managed process must remain verified.

Earlier versions rejected messages after these operations with `Crew could not verify this delivery`; the daemon’s underlying response was `HTTP 403: Native prompt identity mismatch`. The hook now reports HTTP rejection reasons and request timeouts explicitly. See the [native incident record](../exec-plans/completed/native-prompt-normalization.md#conversation-reset-identity-mismatch).

After rebuilding, restart the daemon to load this fix. Agents launched before this fix need an explicit crew shutdown and relaunch to install the clear/resume hooks. Successful `crew down` clears saved messages, so retain any requests you want to resend first. Existing uncertain attempts are not automatically retried.

### Prompt hook mismatch

If Claude reports `Submitted prompt does not match the saved Crew delivery`, inspect the saved message and its attempts first. Claude 2.1.293 removes trailing whitespace before its prompt hook; older Crew verification incorrectly rejected messages ending in a newline. The [normalization incident](../exec-plans/completed/native-prompt-normalization.md) records the diagnosis and fix. Other content mismatches still trigger the guard.

After rebuilding Crew, restart the affected daemon to load changed verifier code. Use the same `--state-dir` or `CREW_HOME` as the original run. Daemon restart preserves surviving agent sessions; it does not automatically retry uncertain messages.

```sh
crew message show <message-id> --crew <crew-name> --json
crew daemon stop
crew daemon start
crew status --crew <crew-name> --json
```

If the message remains unacknowledged and its latest attempt is uncertain, retry only after accepting that delivery might be duplicated:

```sh
crew message retry <message-id> --crew <crew-name> --allow-duplicate --json
```

A retry creates a new attempt for the same saved message. Inspect its result; `submitted` means native prompt verification, not completion. If status shows missing or unverified executions, inspect and explicitly shut down the crew before relaunching. Do not clear a draft, remove submission records, or disable the hook to force delivery.

## Shutdown and guidance changes

```sh
node dist/cli.js down --crew demo-crew --json
node dist/cli.js daemon stop
```

Crew shutdown stops its managed executions, then deletes that crew’s saved messages, replies, acknowledgments, delivery attempts, and submission artifacts. Execution history and other crews remain intact. A failed shutdown preserves messages. The JSON result includes `messagesCleared`.

To clear saved messages without stopping agents, use `crew message clear --crew <name> --json`. This operator-only command also accepts project/profile selectors. It does not erase messages already visible in Claude conversations or terminal drafts.

Daemon shutdown leaves agent terminals and saved messages intact. Restarting coordination reconciles surviving executions and resumes eligible pending delivery.

Root project guidance is captured at launch and contributes to the configuration digest. Editing `AGENTS.md` or `CLAUDE.md` can make a later launch report a mismatch. Profile runs can adopt updated guidance after verified shutdown; legacy configuration launch keeps its existing mismatch behavior. Inspect the current state rather than deleting records or replacing live executions to bypass the check.

Native tool permissions still follow Claude Code settings. In the planning-profile validation, Claude Code's auto mode classifier rejected a linked `crew reply` as Data Exfiltration. Startup, context injection, and deterministic coordination checks passed; that live reply check did not. No permission settings were changed. See the [validation record](../exec-plans/active/project-runs.md).
