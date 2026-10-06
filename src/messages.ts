import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import type { Crews } from './crews.js';
import { DeliveryAttempts, type PromptSubmission } from './delivery-attempts.js';

export interface MessageCaller {
  crew: string;
  seatId: string | null;
  executionId: string | null;
}

interface MessageRow {
  id: string;
  request_id: string;
  crew_id: string;
  crew: string;
  sender_seat_id: string | null;
  sender_execution_id: string | null;
  sender: string | null;
  recipient_seat_id: string | null;
  recipient: string | null;
  body: string;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_execution_id: string | null;
  reply_to: string | null;
}

export class Messages {
  private attempts: DeliveryAttempts;

  constructor(private db: Database.Database, crews: Crews, directory: string) {
    this.attempts = new DeliveryAttempts(db, crews, directory);
  }

  private crew(caller: MessageCaller) {
    const crew = this.db.prepare('SELECT id FROM crews WHERE name = ?').get(caller.crew) as { id: string } | undefined;
    if (!crew) throw new HTTPException(404, { message: 'Unknown crew' });
    return crew.id;
  }

  send(caller: MessageCaller, recipient: string, body: string, requestId: string) {
    const crewId = this.crew(caller);
    const seat = this.db.prepare('SELECT id FROM seats WHERE crew_id = ? AND name = ?').get(crewId, recipient) as { id: string } | undefined;
    if (!seat) throw new HTTPException(404, { message: 'Unknown recipient seat' });
    return this.persist(caller, seat.id, body, requestId, null);
  }

  reply(caller: MessageCaller, id: string, body: string, requestId: string) {
    const original = this.show(caller, id);
    return this.persist(caller, original.sender.seatId, body, requestId, id);
  }

  private persist(caller: MessageCaller, recipientId: string | null, body: string, requestId: string, replyTo: string | null) {
    const crewId = this.crew(caller);
    const id = randomUUID();
    const created = new Date().toISOString();
    const persistedId = this.db.transaction(() => {
      if (replyTo) this.ack(caller, replyTo);
      const previous = this.db.prepare('SELECT id, recipient_seat_id, body, reply_to FROM messages WHERE crew_id = ? AND sender_key = ? AND request_id = ?')
        .get(crewId, caller.executionId ?? 'operator', requestId) as { id: string; recipient_seat_id: string | null; body: string; reply_to: string | null } | undefined;
      if (previous) {
        if (previous.recipient_seat_id !== recipientId || previous.body !== body || previous.reply_to !== replyTo) throw new HTTPException(409, { message: 'Request identifier was already used with different content' });
        return previous.id;
      }
      this.db.prepare(`INSERT INTO messages (id, crew_id, request_id, sender_key, sender_seat_id, sender_execution_id,
        recipient_seat_id, body, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, crewId, requestId, caller.executionId ?? 'operator', caller.seatId, caller.executionId, recipientId, body, created, replyTo);
      if (recipientId) this.attempts.enqueue(id, created);
      return id;
    }).immediate();
    return this.show(caller, persistedId);
  }

  ack(caller: MessageCaller, id: string) {
    const message = this.show(caller, id);
    if (!caller.seatId || !caller.executionId || message.recipient.seatId !== caller.seatId)
      throw new HTTPException(403, { message: 'Only the current recipient execution can acknowledge or reply' });
    this.db.prepare('UPDATE messages SET acknowledged_at = ?, acknowledged_execution_id = ? WHERE id = ? AND acknowledged_at IS NULL')
      .run(new Date().toISOString(), caller.executionId, id);
    return this.show(caller, id);
  }

  show(caller: MessageCaller, id: string) {
    const row = this.db.prepare(`SELECT m.*, c.name AS crew, sender.name AS sender, recipient.name AS recipient
      FROM messages m JOIN crews c ON c.id = m.crew_id LEFT JOIN seats sender ON sender.id = m.sender_seat_id
      LEFT JOIN seats recipient ON recipient.id = m.recipient_seat_id WHERE m.id = ? AND m.crew_id = ?`)
      .get(id, this.crew(caller)) as MessageRow | undefined;
    if (!row || (caller.seatId && row.sender_seat_id !== caller.seatId && row.recipient_seat_id !== caller.seatId))
      throw new HTTPException(404, { message: 'Message not found in your scope' });
    return { id: row.id, requestId: row.request_id, crew: row.crew,
      sender: { kind: row.sender_seat_id ? 'agent' : 'operator', seat: row.sender, seatId: row.sender_seat_id, executionId: row.sender_execution_id },
      recipient: { kind: row.recipient_seat_id ? 'agent' : 'operator', seat: row.recipient, seatId: row.recipient_seat_id }, body: row.body, createdAt: row.created_at, acknowledgedAt: row.acknowledged_at,
      replyTo: row.reply_to, replies: this.db.prepare('SELECT id, created_at AS createdAt FROM messages WHERE reply_to = ? ORDER BY rowid').all(id),
      acknowledgment: row.acknowledged_at ? { executionId: row.acknowledged_execution_id, acknowledgedAt: row.acknowledged_at } : null,
      deliveries: this.attempts.history(id),
    };
  }

  retry(caller: MessageCaller, id: string, allowDuplicate: boolean) {
    this.show(caller, id);
    this.attempts.retry(id, allowDuplicate);
    return this.show(caller, id);
  }

  issues(caller: MessageCaller) {
    return this.attempts.issues(this.crew(caller), caller.seatId).map((row) => this.show(caller, row.id));
  }

  start() {
    this.attempts.start();
  }

  stop() {
    return this.attempts.stop();
  }

  verifyPrompt(caller: Parameters<DeliveryAttempts['verifyPrompt']>[0], input: PromptSubmission & { attemptId: string }) {
    return this.attempts.verifyPrompt(caller, input);
  }

  inbox(caller: MessageCaller, all: boolean) {
    const rows = this.db.prepare(`SELECT id FROM messages WHERE crew_id = ? AND (? IS NULL OR recipient_seat_id = ?)
      AND (? = 1 OR acknowledged_at IS NULL) ORDER BY rowid`).all(this.crew(caller), caller.seatId, caller.seatId, all ? 1 : 0) as { id: string }[];
    return { crew: caller.crew, messages: rows.map((row) => this.show(caller, row.id)) };
  }
}
