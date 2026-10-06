import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { processAlive } from './state.js';

export function openDatabase(path: string, bootId: string) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.transaction(() => {
    if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('001_daemon_lifecycle')) return;
    db.exec(`CREATE TABLE daemon_lifecycle (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      instance_id TEXT NOT NULL,
      pid INTEGER,
      boot_id TEXT,
      started_at TEXT,
      stopped_at TEXT,
      boot_count INTEGER NOT NULL DEFAULT 0
    )`);
    db.prepare('INSERT INTO daemon_lifecycle (singleton, instance_id) VALUES (1, ?)').run(randomUUID());
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
      .run('001_daemon_lifecycle', new Date().toISOString());
  }).immediate();

  try {
    db.transaction(() => {
      const owner = db.prepare('SELECT pid FROM daemon_lifecycle WHERE singleton = 1').get() as { pid: number | null };
      if (owner.pid !== null && processAlive(owner.pid)) {
        throw new Error(`Daemon PID ${owner.pid} still exists; refusing to replace a live or unresponsive instance.`);
      }
      db.prepare(`UPDATE daemon_lifecycle SET pid = ?, boot_id = ?, started_at = ?, stopped_at = NULL,
        boot_count = boot_count + 1 WHERE singleton = 1`).run(process.pid, bootId, new Date().toISOString());
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }

  db.transaction(() => {
    if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('002_single_seat')) return;
    db.exec(`
      CREATE TABLE crews (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, project TEXT NOT NULL, config_path TEXT NOT NULL);
      CREATE TABLE seats (id TEXT PRIMARY KEY, crew_id TEXT NOT NULL REFERENCES crews(id), name TEXT NOT NULL,
        role_path TEXT NOT NULL, UNIQUE(crew_id, name));
      CREATE TABLE executions (id TEXT PRIMARY KEY, seat_id TEXT NOT NULL REFERENCES seats(id),
        generation TEXT NOT NULL UNIQUE, native_session_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('launching', 'ready', 'failed')), cwd TEXT NOT NULL,
        failure TEXT, context_path TEXT, tmux_session TEXT, tmux_pane TEXT,
        created_at TEXT NOT NULL, ready_at TEXT);
      CREATE UNIQUE INDEX execution_one_active ON executions(seat_id) WHERE status IN ('launching', 'ready');
    `);
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
      .run('002_single_seat', new Date().toISOString());
  }).immediate();

  db.transaction(() => {
    if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('003_seat_roles')) return;
    db.exec('ALTER TABLE seats ADD COLUMN role TEXT');
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
      .run('003_seat_roles', new Date().toISOString());
  }).immediate();

  db.transaction(() => {
    if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('004_crew_lifecycle')) return;
    db.exec(`ALTER TABLE crews ADD COLUMN config_digest TEXT;
      ALTER TABLE executions ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE executions ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;
      DROP INDEX execution_one_active;
      CREATE UNIQUE INDEX execution_one_active ON executions(seat_id) WHERE state = 'active' AND status IN ('launching', 'ready');`);
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('004_crew_lifecycle', new Date().toISOString());
  }).immediate();

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

  db.transaction(() => {
    if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('006_terminal_delivery')) return;
    db.exec(`ALTER TABLE executions ADD COLUMN runtime_version TEXT;
      ALTER TABLE delivery_attempts ADD COLUMN generation TEXT;
      ALTER TABLE delivery_attempts ADD COLUMN pane TEXT;
      ALTER TABLE delivery_attempts ADD COLUMN submitting_at TEXT;
      ALTER TABLE delivery_attempts ADD COLUMN submitted_at TEXT;`);
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('006_terminal_delivery', new Date().toISOString());
  }).immediate();

  if (!db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('007_message_receipts')) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`CREATE TABLE messages_next (
          id TEXT PRIMARY KEY, crew_id TEXT NOT NULL REFERENCES crews(id), request_id TEXT NOT NULL,
          sender_key TEXT NOT NULL, sender_seat_id TEXT REFERENCES seats(id), sender_execution_id TEXT REFERENCES executions(id),
          recipient_seat_id TEXT REFERENCES seats(id), body TEXT NOT NULL, created_at TEXT NOT NULL,
          acknowledged_at TEXT, acknowledged_execution_id TEXT REFERENCES executions(id), reply_to TEXT REFERENCES messages(id),
          UNIQUE(crew_id, sender_key, request_id));
          INSERT INTO messages_next (id, crew_id, request_id, sender_key, sender_seat_id, sender_execution_id,
            recipient_seat_id, body, created_at, acknowledged_at)
            SELECT id, crew_id, request_id, sender_key, sender_seat_id, sender_execution_id,
              recipient_seat_id, body, created_at, acknowledged_at FROM messages ORDER BY rowid;
          DROP TABLE messages;
          ALTER TABLE messages_next RENAME TO messages;
          CREATE INDEX messages_inbox ON messages(recipient_seat_id, acknowledged_at);
          CREATE INDEX messages_replies ON messages(reply_to);`);
        if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Message migration violated foreign keys');
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('007_message_receipts', new Date().toISOString());
      }).immediate();
    } finally { db.pragma('foreign_keys = ON'); }
  }

  db.transaction(() => {
    if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('009_delivery_retry')) return;
    db.exec("CREATE UNIQUE INDEX delivery_one_active ON delivery_attempts(message_id) WHERE status IN ('pending', 'submitting')");
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('009_delivery_retry', new Date().toISOString());
  }).immediate();

  db.transaction(() => {
    if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('010_prompt_verification')) return;
    db.exec(`ALTER TABLE delivery_attempts ADD COLUMN prompt_verified_at TEXT;
      ALTER TABLE delivery_attempts ADD COLUMN prompt_hash TEXT;
      ALTER TABLE delivery_attempts ADD COLUMN native_prompt_id TEXT;`);
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('010_prompt_verification', new Date().toISOString());
  }).immediate();

  db.transaction(() => {
    if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('011_runtime_activity')) return;
    db.exec(`CREATE TABLE execution_activity (execution_id TEXT PRIMARY KEY REFERENCES executions(id),
      event TEXT NOT NULL, state TEXT NOT NULL, event_at TEXT NOT NULL, received_at TEXT NOT NULL)`);
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('011_runtime_activity', new Date().toISOString());
  }).immediate();
  return db;
}
