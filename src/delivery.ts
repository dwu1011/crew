import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Crews } from './crews.js';
import { observeClaudeInput } from './claude-input.js';

const exec = promisify(execFile);
interface Pending {
  id: string; message_id: string; recipient_seat_id: string; recipient: string; sender: string | null; body: string;
}

export class Delivery {
  private accepted = new Set<string>();
  private jobs = new Map<string, Promise<void>>();
  private stopping = false;
  private timer: ReturnType<typeof setInterval>;

  constructor(private db: Database.Database, private crews: Crews, private directory: string) {
    db.transaction(() => {
      if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('006_terminal_delivery')) return;
      db.exec(`ALTER TABLE executions ADD COLUMN runtime_version TEXT;
        ALTER TABLE delivery_attempts ADD COLUMN generation TEXT;
        ALTER TABLE delivery_attempts ADD COLUMN pane TEXT;
        ALTER TABLE delivery_attempts ADD COLUMN submitting_at TEXT;
        ALTER TABLE delivery_attempts ADD COLUMN submitted_at TEXT;`);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('006_terminal_delivery', new Date().toISOString());
    }).immediate();
    this.timer = setInterval(() => this.tick(), 400);
    this.timer.unref();
  }

  enqueue(id: string) {
    if (this.db.prepare("SELECT id FROM delivery_attempts WHERE message_id = ? AND status = 'pending'").get(id)) this.accepted.add(id);
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.jobs.values());
  }

  private tick() {
    if (this.stopping) return;
    const pending = this.db.prepare(`SELECT a.id, m.id AS message_id, m.recipient_seat_id, m.body, recipient.name AS recipient, sender.name AS sender
      FROM delivery_attempts a JOIN messages m ON m.id = a.message_id JOIN seats recipient ON recipient.id = m.recipient_seat_id
      LEFT JOIN seats sender ON sender.id = m.sender_seat_id WHERE a.status = 'pending' ORDER BY m.rowid, a.rowid`).all() as Pending[];
    for (const attempt of pending) {
      if (!this.accepted.has(attempt.message_id) || this.jobs.has(attempt.recipient_seat_id)) continue;
      const task = this.crews.withRecipient(attempt.recipient_seat_id, () => this.deliver(attempt))
        .catch((error: Error) => this.db.prepare("UPDATE delivery_attempts SET failure = ? WHERE id = ? AND status = 'pending'").run(error.message, attempt.id))
        .then(() => {});
      this.jobs.set(attempt.recipient_seat_id, task);
      task.finally(() => this.jobs.delete(attempt.recipient_seat_id)).catch(() => {});
    }
  }

  private async deliver(attempt: Pending) {
    const tmux = (args: string[]) => exec('tmux', ['-S', this.crews.socket, ...args], { timeout: 2000 });
    const defer = (reason: string) => this.db.prepare("UPDATE delivery_attempts SET failure = ? WHERE id = ? AND status = 'pending'").run(reason, attempt.id);
    const resolved = await this.crews.deliveryTarget(attempt.recipient_seat_id);
    if (!resolved.target) { defer(resolved.reason!); return; }
    const target = resolved.target;
    const input = await observeClaudeInput(this.crews.socket, target.pane, target.version);
    if (input.state !== 'empty') { defer(input.reason!); return; }
    const envelope = `[Crew message ${attempt.message_id}]\nSender: ${attempt.sender ?? 'operator'}\nRecipient: ${attempt.recipient}\nBody:\n${attempt.body}\nReply guidance: crew reply ${attempt.message_id} --text <body>; or crew ack ${attempt.message_id}.`;
    const root = join(this.directory, 'delivery');
    const path = join(root, `${attempt.id}.txt`);
    const buffer = `crew-${attempt.id}`;
    let inputAttempted = false;
    try {
      if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(envelope)) throw new Error('Unsupported terminal control characters in message body');
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(path, envelope, { mode: 0o600 });
      await tmux(['load-buffer', '-b', buffer, path]);
      const verified = await this.crews.deliveryTarget(attempt.recipient_seat_id);
      const ready = await observeClaudeInput(this.crews.socket, target.pane, target.version);
      if (!verified.target || verified.target.executionId !== target.executionId || verified.target.generation !== target.generation
        || verified.target.pane !== target.pane || !this.crews.currentTarget(target)) throw new Error('Recipient target changed before input');
      if (this.stopping || ready.state !== 'empty') { defer(this.stopping ? 'Daemon is stopping' : ready.reason!); return; }
      this.db.prepare("UPDATE delivery_attempts SET status = 'submitting', execution_id = ?, generation = ?, pane = ?, submitting_at = ?, failure = NULL WHERE id = ? AND status = 'pending'")
        .run(target.executionId, target.generation, target.pane, new Date().toISOString(), attempt.id);
      inputAttempted = true;
      const condition = (frame: { x: number; y: number }) => [
        ['pane_pid', target.runnerPid], ['session_name', target.session], ['cursor_x', frame.x], ['cursor_y', frame.y], ['pane_in_mode', 0], ['pane_input_off', 0],
      ].map(([key, value]) => `#{==:#{${key}},${value}}`).reduce((previous, check) => `#{&&:${previous},${check}}`);
      const pasted = await tmux(['if-shell', '-F', '-t', target.pane, condition(ready),
        `paste-buffer -t ${target.pane} -b ${buffer} -r ; display-message -p crew-pasted`, 'display-message -p crew-refused']);
      if (pasted.stdout.trim() !== 'crew-pasted') { if (pasted.stdout.trim() === 'crew-refused') inputAttempted = false; throw new Error('Terminal target or cursor changed before paste'); }
      const expectedPrompt = envelope.split('\n').map((line) => line.trimEnd()).join('\n');
      const deadline = Date.now() + 1800;
      let draft: Awaited<ReturnType<typeof observeClaudeInput>>;
      for (;;) {
        const after = await this.crews.deliveryTarget(attempt.recipient_seat_id);
        draft = await observeClaudeInput(this.crews.socket, target.pane, target.version);
        if (this.stopping || !after.target || after.target.executionId !== target.executionId || !this.crews.currentTarget(target) || draft.state === 'blocked')
          throw new Error('Recipient target or input safety changed after paste');
        const ownPaste = draft.prompt.replace(/^❯[ \u00a0]/, '') === expectedPrompt;
        if (draft.state === 'draft' && ownPaste) break;
        if (Date.now() >= deadline) throw new Error(`Pasted input could not be verified before Enter: ${draft.reason ?? draft.state}`);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      const entered = await tmux(['if-shell', '-F', '-t', target.pane, condition(draft),
        `send-keys -t ${target.pane} Enter ; display-message -p crew-entered`, 'display-message -p crew-refused']);
      if (entered.stdout.trim() !== 'crew-entered') throw new Error('Terminal target or cursor changed before Enter');
      this.db.prepare("UPDATE delivery_attempts SET status = 'submitted', submitted_at = ?, failure = NULL WHERE id = ? AND status = 'submitting'")
        .run(new Date().toISOString(), attempt.id);
      this.accepted.delete(attempt.message_id);
    } catch (error) {
      this.db.prepare("UPDATE delivery_attempts SET status = ?, execution_id = ?, generation = ?, pane = ?, failure = ? WHERE id = ?")
        .run(inputAttempted ? 'uncertain' : 'failed', target.executionId, target.generation, target.pane, (error as Error).message, attempt.id);
      this.accepted.delete(attempt.message_id);
    } finally {
      await tmux(['delete-buffer', '-b', buffer]).catch(() => {});
      await unlink(path).catch(() => {});
    }
  }
}
