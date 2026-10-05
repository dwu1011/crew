import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';

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
  recipient_seat_id: string;
  recipient: string;
  body: string;
  created_at: string;
  acknowledged_at: string | null;
}

export class Messages {
  constructor(private db: Database.Database) {
    db.transaction(() => {
      if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('005_durable_messages')) return;
      db.exec(`CREATE TABLE messages (
        id TEXT PRIMARY KEY, crew_id TEXT NOT NULL REFERENCES crews(id), request_id TEXT NOT NULL,
        sender_key TEXT NOT NULL, sender_seat_id TEXT REFERENCES seats(id), sender_execution_id TEXT REFERENCES executions(id),
        recipient_seat_id TEXT NOT NULL REFERENCES seats(id), body TEXT NOT NULL, created_at TEXT NOT NULL,
        acknowledged_at TEXT, UNIQUE(crew_id, sender_key, request_id));
        CREATE INDEX messages_inbox ON messages(recipient_seat_id, acknowledged_at);
        CREATE TABLE delivery_attempts (
          id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
          execution_id TEXT REFERENCES executions(id), status TEXT NOT NULL, created_at TEXT NOT NULL, failure TEXT);
        CREATE INDEX delivery_pending ON delivery_attempts(status);
      `);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('005_durable_messages', new Date().toISOString());
    }).immediate();
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
    const id = randomUUID();
    const created = new Date().toISOString();
    const persistedId = this.db.transaction(() => {
      const previous = this.db.prepare('SELECT id, recipient_seat_id, body FROM messages WHERE crew_id = ? AND sender_key = ? AND request_id = ?')
        .get(crewId, caller.executionId ?? 'operator', requestId) as { id: string; recipient_seat_id: string; body: string } | undefined;
      if (previous) {
        if (previous.recipient_seat_id !== seat.id || previous.body !== body) throw new HTTPException(409, { message: 'Request identifier was already used with different content' });
        return previous.id;
      }
      this.db.prepare(`INSERT INTO messages (id, crew_id, request_id, sender_key, sender_seat_id, sender_execution_id,
        recipient_seat_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, crewId, requestId, caller.executionId ?? 'operator', caller.seatId, caller.executionId, seat.id, body, created);
      this.db.prepare("INSERT INTO delivery_attempts (id, message_id, status, created_at) VALUES (?, ?, 'pending', ?)")
        .run(randomUUID(), id, created);
      return id;
    }).immediate();
    return this.show(caller, persistedId);
  }

  show(caller: MessageCaller, id: string) {
    const row = this.db.prepare(`SELECT m.*, c.name AS crew, sender.name AS sender, recipient.name AS recipient
      FROM messages m JOIN crews c ON c.id = m.crew_id LEFT JOIN seats sender ON sender.id = m.sender_seat_id
      JOIN seats recipient ON recipient.id = m.recipient_seat_id WHERE m.id = ? AND m.crew_id = ?`)
      .get(id, this.crew(caller)) as MessageRow | undefined;
    if (!row || (caller.seatId && row.sender_seat_id !== caller.seatId && row.recipient_seat_id !== caller.seatId))
      throw new HTTPException(404, { message: 'Message not found in your scope' });
    return { id: row.id, requestId: row.request_id, crew: row.crew,
      sender: { kind: row.sender_seat_id ? 'agent' : 'operator', seat: row.sender, seatId: row.sender_seat_id, executionId: row.sender_execution_id },
      recipient: { seat: row.recipient, seatId: row.recipient_seat_id }, body: row.body, createdAt: row.created_at, acknowledgedAt: row.acknowledged_at,
      deliveries: (this.db.prepare('SELECT id, execution_id, status, created_at, failure FROM delivery_attempts WHERE message_id = ? ORDER BY rowid').all(id) as
        { id: string; execution_id: string | null; status: string; created_at: string; failure: string | null }[])
        .map((attempt) => ({ id: attempt.id, executionId: attempt.execution_id, status: attempt.status, createdAt: attempt.created_at, failure: attempt.failure })),
    };
  }

  inbox(caller: MessageCaller, all: boolean) {
    const rows = this.db.prepare(`SELECT id FROM messages WHERE crew_id = ? AND (? IS NULL OR recipient_seat_id = ?)
      AND (? = 1 OR acknowledged_at IS NULL) ORDER BY rowid`).all(this.crew(caller), caller.seatId, caller.seatId, all ? 1 : 0) as { id: string }[];
    return { crew: caller.crew, messages: rows.map((row) => this.show(caller, row.id)) };
  }
}
