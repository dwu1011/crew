import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { processIdentity } from './process-identity.js';
import { processAlive } from './state.js';
import { observeClaudeInput } from './claude-input.js';

const exec = promisify(execFile);
const missingTerminal = /no server running|can't find|no such|\(No such file or directory\)|\(Connection refused\)/;
interface ExecutionIdentity {
  id: string;
  generation: string;
  native_session_id: string;
  cwd: string;
  status: string;
  tmux_pane: string | null;
}
export interface InputOptions {
  id: string;
  isStopping: () => boolean;
}
export interface InputSession {
  binding: Readonly<{ executionId: string; generation: string; pane: string }>;
  submit(text: string, beforePaste: () => Promise<boolean>): Promise<InputResult>;
}
type InputResult =
  | { kind: 'entered' | 'cancelled' }
  | { kind: 'deferred' | 'refused' | 'failed' | 'uncertain'; reason: string };

export class ManagedExecutions {
  readonly socket: string;

  constructor(private db: Database.Database, private directory: string) {
    this.socket = join(directory, 'tmux.sock');
  }

  activity(executionId: string) {
    return this.db.prepare('SELECT event, state, event_at AS eventAt, received_at AS receivedAt FROM execution_activity WHERE execution_id = ?').get(executionId) as
      { event: string; state: string; eventAt: string; receivedAt: string } | undefined;
  }

  recordActivity(executionId: string, event: string, eventAt: string, toolName?: string) {
    const state = event === 'Stop' || event === 'SessionStart' ? 'idle'
      : event === 'PermissionRequest' || (event === 'PreToolUse' && ['AskUserQuestion', 'ExitPlanMode'].includes(toolName ?? '')) ? 'needs_input' : 'running';
    this.db.prepare(`INSERT INTO execution_activity (execution_id, event, state, event_at, received_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET event = excluded.event, state = excluded.state, event_at = excluded.event_at, received_at = excluded.received_at
      WHERE excluded.event_at > execution_activity.event_at`).run(executionId, event, state, eventAt, new Date().toISOString());
    return this.activity(executionId);
  }

  async inspect(execution: ExecutionIdentity) {
    let receipt: { executionId: string; generation: string; nativeSessionId: string; cwd: string;
      runnerPid: number; runnerIdentity: string; nativePid: number | null; nativeIdentity: string | null } | undefined;
    try {
      const candidate = JSON.parse(await readFile(join(this.directory, 'executions', execution.id, 'process.json'), 'utf8'));
      if (!Number.isSafeInteger(candidate?.runnerPid) || candidate.runnerPid < 1
        || !(candidate.nativePid === null || (Number.isSafeInteger(candidate.nativePid) && candidate.nativePid > 0))) throw new Error('Invalid process receipt');
      receipt = candidate;
    }
    catch { /* Older or incomplete executions cannot prove ownership. */ }
    let pane: string[];
    try {
      await exec('tmux', ['-S', this.socket, 'has-session', '-t', `=crew-${execution.id}`], { timeout: 2000 });
      pane = (await exec('tmux', ['-S', this.socket, 'display-message', '-p', '-t', execution.tmux_pane ?? `=crew-${execution.id}:0.0`,
        '#{session_name}\t#{pane_id}\t#{pane_pid}'], { timeout: 2000 })).stdout.trim().split('\t');
    } catch (error) {
      const missing = missingTerminal.test((error as { stderr?: string }).stderr ?? '');
      const alive = receipt && (processAlive(receipt.runnerPid) || (receipt.nativePid !== null && processAlive(receipt.nativePid)));
      return { ownership: missing && !alive ? 'absent' : 'unknown', ready: false, receipt, reason: missing ? 'Managed terminal or process is missing' : 'Managed terminal cannot be verified' };
    }
    if (!receipt || receipt.executionId !== execution.id || receipt.generation !== execution.generation
      || receipt.nativeSessionId !== execution.native_session_id || receipt.cwd !== execution.cwd
      || pane[0] !== `crew-${execution.id}` || (execution.tmux_pane && pane[1] !== execution.tmux_pane)
      || Number(pane[2]) !== receipt.runnerPid || !receipt.runnerIdentity || processIdentity(receipt.runnerPid) !== receipt.runnerIdentity) {
      return { ownership: 'unknown', ready: false, receipt, reason: 'Managed terminal ownership does not match the recorded execution' };
    }
    if (!receipt.nativePid || !receipt.nativeIdentity || processIdentity(receipt.nativePid) !== receipt.nativeIdentity) {
      return { ownership: 'owned', ready: false, receipt, reason: 'Native process is missing or mismatched' };
    }
    let ready = execution.status === 'ready';
    try {
      const marker = JSON.parse(await readFile(join(this.directory, 'executions', execution.id, 'ready.json'), 'utf8'));
      ready ||= marker.generation === execution.generation && marker.sessionId === execution.native_session_id && marker.cwd === execution.cwd;
    } catch { /* A live process can still be waiting for native startup. */ }
    return { ownership: 'owned', ready, receipt, reason: null };
  }

  private async deliveryTarget(seatId: string) {
    const execution = this.db.prepare('SELECT * FROM executions WHERE seat_id = ? ORDER BY rowid DESC LIMIT 1').get(seatId) as ExecutionIdentity & { state: string };
    if (execution.state !== 'active' || execution.status !== 'ready' || !execution.tmux_pane)
      return { target: null, reason: 'Recipient execution is not confirmed ready' };
    const observed = await this.inspect(execution);
    if (observed.ownership !== 'owned' || !observed.ready || observed.reason)
      return { target: null, reason: observed.reason ?? 'Recipient process is unverified' };
    const ready = JSON.parse(await readFile(join(this.directory, 'executions', execution.id, 'ready.json'), 'utf8').catch(() => '{}'));
    if (ready.submissionProtocol !== 1 || ready.generation !== execution.generation || ready.sessionId !== execution.native_session_id || ready.cwd !== execution.cwd)
      return { target: null, reason: 'Execution has no verified prompt hook; stop and relaunch this crew to install submission verification' };
    return { target: { executionId: execution.id, generation: execution.generation, seatId, pane: execution.tmux_pane,
      session: `crew-${execution.id}`, runnerPid: observed.receipt!.runnerPid, activity: this.activity(execution.id) }, reason: null };
  }

  private currentTarget(target: { executionId: string; generation: string; pane: string }) {
    return !!this.db.prepare("SELECT id FROM executions WHERE id = ? AND generation = ? AND tmux_pane = ? AND state = 'active' AND status = 'ready'")
      .get(target.executionId, target.generation, target.pane);
  }

  async withInput<T>(seatId: string, options: InputOptions, operation: (input: InputSession) => Promise<T>) {
    const resolved = await this.deliveryTarget(seatId);
    if (!resolved.target) return { ready: false as const, reason: resolved.reason! };
    const target = resolved.target;
    if (target.activity && target.activity.state !== 'idle')
      return { ready: false as const, reason: `Native activity ${target.activity.event}: ${target.activity.state}` };
    const input = await observeClaudeInput(this.socket, target.pane, target.activity?.state === 'idle');
    if (input.state !== 'empty') return { ready: false as const, reason: input.reason! };
    let submitted = false;
    try {
      const value = await operation({
        binding: { executionId: target.executionId, generation: target.generation, pane: target.pane },
        submit: (text, beforePaste) => {
          submitted = true;
          return this.submit(seatId, target, options, text, beforePaste);
        },
      });
      return { ready: true as const, value };
    } finally {
      if (submitted) {
        await exec('tmux', ['-S', this.socket, 'delete-buffer', '-b', `crew-${options.id}`], { timeout: 2000 }).catch(() => {});
        await unlink(join(this.directory, 'delivery', `${options.id}.txt`)).catch(() => {});
      }
    }
  }

  private async submit(seatId: string, target: NonNullable<Awaited<ReturnType<ManagedExecutions['deliveryTarget']>>['target']>,
    options: InputOptions, text: string, beforePaste: () => Promise<boolean>): Promise<InputResult> {
    const tmux = (args: string[]) => exec('tmux', ['-S', this.socket, ...args], { timeout: 2000 });
    const root = join(this.directory, 'delivery');
    const path = join(root, `${options.id}.txt`);
    const buffer = `crew-${options.id}`;
    let inputAttempted = false;
    try {
      if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) throw new Error('Unsupported terminal control characters in message body');
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(path, text, { mode: 0o600 });
      await tmux(['load-buffer', '-b', buffer, path]);
      const verified = await this.deliveryTarget(seatId);
      const ready = await observeClaudeInput(this.socket, target.pane, verified.target?.activity?.state === 'idle');
      if (!verified.target || verified.target.executionId !== target.executionId || verified.target.generation !== target.generation
        || verified.target.pane !== target.pane || !this.currentTarget(target)) return { kind: 'deferred', reason: 'Recipient target changed before input; waiting for verified execution' };
      if (options.isStopping() || ready.state !== 'empty' || (verified.target.activity && verified.target.activity.state !== 'idle')) return { kind: 'deferred', reason: options.isStopping() ? 'Daemon is stopping' : ready.reason ?? 'Native execution is no longer idle' };
      if (!await beforePaste()) return { kind: 'cancelled' };
      inputAttempted = true;
      const condition = (frame: { x: number; y: number; width: number; height: number }) => [
        ['pane_pid', target.runnerPid], ['session_name', target.session], ['cursor_x', frame.x], ['cursor_y', frame.y], ['pane_width', frame.width], ['pane_height', frame.height], ['pane_in_mode', 0], ['pane_input_off', 0],
      ].map(([key, value]) => `#{==:#{${key}},${value}}`).reduce((previous, check) => `#{&&:${previous},${check}}`);
      const pasted = await tmux(['if-shell', '-F', '-t', target.pane, condition(ready),
        `paste-buffer -t ${target.pane} -b ${buffer} -r -p ; display-message -p crew-pasted`, 'display-message -p crew-refused']);
      if (pasted.stdout.trim() === 'crew-refused') {
        inputAttempted = false;
        return { kind: 'refused', reason: 'Terminal target or cursor changed before paste; waiting for safe input' };
      }
      if (pasted.stdout.trim() !== 'crew-pasted') throw new Error('Paste outcome could not be verified');
      const deadline = Date.now() + 1800;
      let draft: Awaited<ReturnType<typeof observeClaudeInput>>;
      for (;;) {
        const after = await this.deliveryTarget(seatId);
        draft = await observeClaudeInput(this.socket, target.pane, after.target?.activity?.state === 'idle');
        if (options.isStopping() || !after.target || after.target.executionId !== target.executionId || !this.currentTarget(target) || draft.state === 'blocked' || after.target.activity && after.target.activity.state !== 'idle')
          throw new Error('Recipient target or input safety changed after paste');
        if (draft.state === 'draft') break;
        if (Date.now() >= deadline) throw new Error(`Pasted input could not be verified before Enter: ${draft.reason ?? draft.state}`);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      const entered = await tmux(['if-shell', '-F', '-t', target.pane, condition(draft),
        `send-keys -t ${target.pane} Enter ; display-message -p crew-entered`, 'display-message -p crew-refused']);
      if (entered.stdout.trim() !== 'crew-entered') throw new Error('Terminal target or cursor changed before Enter');
      return { kind: 'entered' };
    } catch (error) {
      return { kind: inputAttempted ? 'uncertain' : 'failed', reason: (error as Error).message };
    }
  }
}
