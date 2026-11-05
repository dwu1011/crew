import type Database from 'better-sqlite3';
import { mkdir, writeFile, unlink, readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { join } from 'node:path';
import type { Crews } from './crews.js';

interface Pending {
  id: string; message_id: string; recipient_seat_id: string; sender: string | null; body: string;
}

export interface PromptSubmission {
  sessionId: string;
  cwd: string;
  prompt: string;
  nativePromptId?: string;
  eventAt?: string;
}

const envelope = (attempt: Pending) => `From: ${attempt.sender ?? 'operator'}\n[crew message=${attempt.message_id} attempt=${attempt.id}]\n\n${attempt.body}`;

export async function verifyProtectedPrompt(root: string, input: PromptSubmission,
  verify: (input: PromptSubmission & { attemptId: string }) => Promise<{ verified: boolean; reason?: string }>) {
  let protectedPath: string | undefined;
  let managed = false;
  let blockedReason: string | undefined;
  try {
    let attemptId = input.prompt.match(/\[crew message=[0-9a-f-]{36} attempt=([0-9a-f-]{36})\]/)?.[1];
    const submissions = join(root, 'submissions');
    const files = await readdir(submissions).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const file = attemptId ? files.find((file) => file === `${attemptId}.json`) : files[0];
    if (file) {
      protectedPath = join(submissions, file);
      attemptId = file.replace(/\.json$/, '');
    }
    if (attemptId) {
      managed = true;
      const result = await verify({ ...input, attemptId });
      if (!result.verified) blockedReason = result.reason;
    }
  } catch {
    blockedReason = 'Crew could not verify this delivery; inspect its attempt before retrying.';
  } finally {
    if (protectedPath) await unlink(protectedPath).catch(() => {});
  }
  return { managed, blockedReason };
}

export class DeliveryAttempts {
  private jobs = new Map<string, Promise<void>>();
  private stopping = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private db: Database.Database, private crews: Crews, private directory: string) {}

  enqueue(messageId: string, createdAt: string) {
    this.db.prepare("INSERT INTO delivery_attempts (id, message_id, status, created_at) VALUES (?, ?, 'pending', ?)")
      .run(randomUUID(), messageId, createdAt);
  }

  history(messageId: string) {
    return (this.db.prepare('SELECT id, execution_id, generation, pane, status, created_at, submitting_at, submitted_at, failure, prompt_verified_at, prompt_hash, native_prompt_id FROM delivery_attempts WHERE message_id = ? ORDER BY rowid').all(messageId) as
        { id: string; execution_id: string | null; generation: string | null; pane: string | null; status: string; created_at: string; submitting_at: string | null; submitted_at: string | null; failure: string | null; prompt_verified_at: string | null; prompt_hash: string | null; native_prompt_id: string | null }[])
        .map((attempt) => ({ id: attempt.id, executionId: attempt.execution_id, generation: attempt.generation, pane: attempt.pane, status: attempt.status, createdAt: attempt.created_at,
          submittingAt: attempt.submitting_at, submittedAt: attempt.submitted_at, failure: attempt.failure,
          promptVerification: attempt.prompt_verified_at ? { verifiedAt: attempt.prompt_verified_at, executionId: attempt.execution_id, nativePromptId: attempt.native_prompt_id, hash: attempt.prompt_hash } : null }));
  }

  retry(messageId: string, allowDuplicate: boolean) {
    this.db.transaction(() => {
      const message = this.db.prepare('SELECT recipient_seat_id, acknowledged_at FROM messages WHERE id = ?').get(messageId) as
        { recipient_seat_id: string | null; acknowledged_at: string | null };
      if (message.acknowledged_at) throw new HTTPException(409, { message: 'Acknowledged messages cannot be retried' });
      if (!message.recipient_seat_id) throw new HTTPException(409, { message: 'Operator replies have no terminal delivery to retry' });
      const latest = this.db.prepare('SELECT status FROM delivery_attempts WHERE message_id = ? ORDER BY rowid DESC LIMIT 1').get(messageId) as { status: string } | undefined;
      if (!latest || !['failed', 'uncertain'].includes(latest.status))
        throw new HTTPException(409, { message: 'Only a definite failure or uncertain delivery can be retried' });
      if (latest.status === 'uncertain' && !allowDuplicate)
        throw new HTTPException(409, { message: 'Uncertain delivery may already have occurred; retry requires --allow-duplicate' });
      this.enqueue(messageId, new Date().toISOString());
    }).immediate();
  }

  issues(crewId: string, seatId: string | null) {
    return this.db.prepare(`SELECT m.id FROM messages m JOIN delivery_attempts a ON a.message_id = m.id
      WHERE m.crew_id = ? AND m.acknowledged_at IS NULL AND (? IS NULL OR m.sender_seat_id = ? OR m.recipient_seat_id = ?)
      AND a.rowid = (SELECT MAX(rowid) FROM delivery_attempts WHERE message_id = m.id)
      AND a.status IN ('failed', 'uncertain') ORDER BY m.rowid`).all(crewId, seatId, seatId, seatId) as { id: string }[];
  }

  verifyPrompt(caller: { executionId: string; seatId: string; generation: string; nativeSessionId: string; cwd: string }, input: PromptSubmission & { attemptId: string }) {
    if (caller.nativeSessionId !== input.sessionId || caller.cwd !== input.cwd) throw new HTTPException(403, { message: 'Native prompt identity mismatch' });
    if (input.eventAt && Date.parse(input.eventAt) > Date.now() + 10000) throw new HTTPException(400, { message: 'Native event timestamp is in the future' });
    return this.db.transaction(() => {
      const attempt = this.db.prepare(`SELECT a.id, m.id AS message_id, m.body, sender.name AS sender,
        m.recipient_seat_id, a.status, a.prompt_verified_at, a.native_prompt_id FROM delivery_attempts a JOIN messages m ON m.id = a.message_id
        JOIN seats recipient ON recipient.id = m.recipient_seat_id LEFT JOIN seats sender ON sender.id = m.sender_seat_id
        WHERE a.id = ? AND a.execution_id = ? AND a.generation = ? AND m.recipient_seat_id = ?`)
        .get(input.attemptId, caller.executionId, caller.generation, caller.seatId) as (Pending & { status: string; prompt_verified_at: string | null; native_prompt_id: string | null }) | undefined;
      if (!attempt) throw new HTTPException(404, { message: 'Delivery attempt not found in this execution' });
      const wrapped = input.prompt.match(/^\n*<pasted_content id="([^"\n]+)">\n([\s\S]*)\n<\/pasted_content id="\1">\n*$/);
      const prompt = wrapped?.[2] ?? input.prompt;
      if (prompt !== envelope(attempt)) {
        this.db.prepare("UPDATE delivery_attempts SET status = 'uncertain', failure = ? WHERE id = ? AND status = 'submitting'")
          .run('Native submitted prompt did not match the persisted delivery; hook blocked processing', attempt.id);
        return { verified: false, reason: 'Submitted prompt does not match the saved Crew delivery.' };
      }
      if (attempt.prompt_verified_at) return { verified: !!input.nativePromptId && attempt.native_prompt_id === input.nativePromptId, reason: 'This attempt already has a native submission receipt.' };
      if (!['submitting', 'uncertain'].includes(attempt.status)) return { verified: false, reason: 'Delivery attempt is not awaiting native submission.' };
      const now = new Date().toISOString();
      this.db.prepare("UPDATE delivery_attempts SET status = 'submitted', submitted_at = COALESCE(submitted_at, ?), prompt_verified_at = ?, prompt_hash = ?, native_prompt_id = ?, failure = NULL WHERE id = ?")
        .run(now, now, createHash('sha256').update(prompt).digest('hex'), input.nativePromptId ?? null, attempt.id);
      this.crews.recordActivity(caller.executionId, 'UserPromptSubmit', input.eventAt ?? now);
      return { verified: true, firstReceipt: true };
    }).immediate();
  }

  start() {
    this.db.prepare("UPDATE delivery_attempts SET status = 'uncertain', failure = 'Daemon restarted during terminal submission; input may have occurred' WHERE status = 'submitting'").run();
    this.timer = setInterval(() => this.tick(), 400);
    this.timer.unref();
    this.tick();
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
      LEFT JOIN seats sender ON sender.id = m.sender_seat_id WHERE a.status = 'pending' AND m.acknowledged_at IS NULL ORDER BY m.rowid, a.rowid`).all() as Pending[];
    for (const attempt of pending) {
      if (this.jobs.has(attempt.recipient_seat_id)) continue;
      const task = this.deliver(attempt)
        .catch((error: Error) => this.db.prepare("UPDATE delivery_attempts SET failure = ? WHERE id = ? AND status = 'pending'").run(error.message, attempt.id))
        .then(() => {});
      this.jobs.set(attempt.recipient_seat_id, task);
      task.finally(() => this.jobs.delete(attempt.recipient_seat_id)).catch(() => {});
    }
  }

  private async deliver(attempt: Pending) {
    const defer = (reason: string) => this.db.prepare("UPDATE delivery_attempts SET failure = ? WHERE id = ? AND status = 'pending'").run(reason, attempt.id);
    const prepared = await this.crews.withInput(attempt.recipient_seat_id, { id: attempt.id, isStopping: () => this.stopping }, async (input) => {
      if (!this.db.prepare("SELECT a.id FROM delivery_attempts a JOIN messages m ON m.id = a.message_id WHERE a.id = ? AND a.status = 'pending' AND m.acknowledged_at IS NULL").get(attempt.id)) return;
      const target = input.binding;
      const submissions = join(this.directory, 'executions', target.executionId, 'submissions');
      const submission = join(submissions, `${attempt.id}.json`);
      const intents = await readdir(submissions).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const file of intents) {
        const active = JSON.parse(await readFile(join(submissions, file), 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '{}';
          throw error;
        }));
        if (active.messageId && active.messageId !== attempt.message_id) { defer('Previous input is awaiting its native hook decision; inspect or explicitly retry that message'); return; }
      }
      let inputAttempted = false;
      try {
        const result = await input.submit(envelope(attempt), async () => {
          const submitting = this.db.prepare("UPDATE delivery_attempts SET status = 'submitting', execution_id = ?, generation = ?, pane = ?, submitting_at = ?, failure = NULL WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM messages WHERE messages.id = delivery_attempts.message_id AND acknowledged_at IS NULL)")
            .run(target.executionId, target.generation, target.pane, new Date().toISOString(), attempt.id);
          if (submitting.changes !== 1) return false;
          await mkdir(submissions, { recursive: true, mode: 0o700 });
          await writeFile(submission, JSON.stringify({ attemptId: attempt.id, messageId: attempt.message_id }), { mode: 0o600, flag: 'wx' });
          return true;
        });
        if (result.kind === 'cancelled') return;
        if (result.kind === 'deferred') { defer(result.reason); return; }
        if (result.kind === 'refused') {
          this.db.prepare("UPDATE delivery_attempts SET status = 'pending', execution_id = NULL, generation = NULL, pane = NULL, submitting_at = NULL, failure = ? WHERE id = ?")
            .run(result.reason, attempt.id);
          return;
        }
        inputAttempted = result.kind === 'entered' || result.kind === 'uncertain';
        if (result.kind === 'failed' || result.kind === 'uncertain') throw new Error(result.reason);
        const receiptDeadline = Date.now() + 3500;
        for (;;) {
          const result = this.db.prepare('SELECT status, failure FROM delivery_attempts WHERE id = ?').get(attempt.id) as { status: string; failure: string | null };
          if (result.status === 'submitted' || result.status === 'uncertain') break;
          if (Date.now() >= receiptDeadline) throw new Error('Enter was sent but the native prompt verification hook did not confirm this attempt');
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      } catch (error) {
        this.db.prepare("UPDATE delivery_attempts SET status = ?, execution_id = ?, generation = ?, pane = ?, failure = ? WHERE id = ? AND prompt_verified_at IS NULL")
          .run(inputAttempted ? 'uncertain' : 'failed', target.executionId, target.generation, target.pane, (error as Error).message, attempt.id);
      } finally {
        if (!inputAttempted) await unlink(submission).catch(() => {});
      }
    });
    if (!prepared.ready) defer(prepared.reason);
  }
}
