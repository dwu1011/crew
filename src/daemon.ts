import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { randomUUID, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { processAlive } from './state.js';
import { Crews } from './crews.js';
import { Messages } from './messages.js';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';

process.umask(0o077);
const directory = resolve(process.argv[2]);
await mkdir(directory, { recursive: true, mode: 0o700 });
const databasePath = join(directory, 'crew.sqlite');
const db = new Database(databasePath);
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

const bootId = randomUUID();
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

const token = randomBytes(32).toString('hex');
const app = new Hono();
const crews = new Crews(db, directory);
const messages = new Messages(db);
await crews.reconcileAll();
let stopping = false;
let url = '';
function status() {
  const row = db.prepare('SELECT instance_id, boot_count, started_at FROM daemon_lifecycle WHERE singleton = 1').get() as
    { instance_id: string; boot_count: number; started_at: string };
  return {
    status: stopping ? 'stopping' : 'running', pid: process.pid, bootId, url,
    startedAt: row.started_at,
    database: { path: databasePath, instanceId: row.instance_id, bootCount: row.boot_count,
      migrations: db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() },
  };
}
app.get('/health', (context) => context.json(status()));
app.get('/status', (context) => context.json(status()));
app.onError((error, context) => {
  if (error instanceof HTTPException) return context.json({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return context.json({ error: 'Request must contain valid JSON' }, 400);
  console.error(error);
  return context.json({ error: 'Internal daemon error; inspect the daemon log' }, 500);
});
app.post('/crews/up', async (context) => {
  if (context.req.header('Authorization') !== `Bearer ${token}`) return context.json({ error: 'Unauthorized' }, 401);
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const body = await context.req.json();
  if (typeof body?.configPath !== 'string' || !isAbsolute(body.configPath)) return context.json({ error: 'configPath must be an absolute path' }, 400);
  return context.json(await crews.launch(body.configPath));
});
app.get('/crews/:name', async (context) => {
  if (context.req.header('Authorization') !== `Bearer ${token}`) return context.json({ error: 'Unauthorized' }, 401);
  return context.json(await crews.status(context.req.param('name')));
});
const executionCredential = (header: string | undefined) => header?.startsWith('Bearer ') ? header.slice(7) : '';
function selectedCaller(header: string | undefined, requested: string | undefined) {
  if (header === `Bearer ${token}`) return { crew: crews.select(requested), seatId: null, executionId: null };
  const caller = crews.whoami(executionCredential(header));
  if (requested && requested !== caller.crew) throw new HTTPException(403, { message: 'Managed executions can only inspect their own crew' });
  return { crew: caller.crew, seatId: caller.seatId, executionId: caller.executionId };
}
app.get('/crews', async (context) => context.json(await crews.status(selectedCaller(context.req.header('Authorization'), context.req.query('crew')).crew)));
app.post('/crews/down', async (context) => {
  if (context.req.header('Authorization') !== `Bearer ${token}`) return context.json({ error: 'Unauthorized' }, 401);
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const body = await context.req.json();
  if (typeof body?.crew !== 'string' || !body.crew) return context.json({ error: 'crew is required' }, 400);
  return context.json(await crews.down(body.crew));
});
app.get('/members', async (context) => context.json(await crews.members(selectedCaller(context.req.header('Authorization'), context.req.query('crew')).crew)));
const submission = z.object({ crew: z.string().min(1).optional(), recipient: z.string().min(1), body: z.string(), requestId: z.string().min(1).max(200) }).strict();
app.post('/messages', async (context) => {
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const parsed = submission.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Expected recipient, body, requestId, and optional crew only' }, 400);
  const body = parsed.data;
  return context.json(messages.send(selectedCaller(context.req.header('Authorization'), body.crew), body.recipient, body.body, body.requestId));
});
app.get('/messages/:id', (context) => context.json(messages.show(selectedCaller(context.req.header('Authorization'), context.req.query('crew')), context.req.param('id'))));
app.get('/inbox', (context) => context.json(messages.inbox(selectedCaller(context.req.header('Authorization'), context.req.query('crew')), context.req.query('all') === 'true')));
app.get('/whoami', (context) => context.json(crews.whoami(executionCredential(context.req.header('Authorization')))));
app.post('/executions/ready', async (context) => {
  const body = await context.req.json();
  if (typeof body?.sessionId !== 'string' || typeof body?.cwd !== 'string') return context.json({ error: 'sessionId and cwd are required' }, 400);
  return context.json(crews.ready(executionCredential(context.req.header('Authorization')), body.sessionId, body.cwd));
});
app.post('/executions/exited', async (context) => {
  const body = await context.req.json();
  if (typeof body?.reason !== 'string') return context.json({ error: 'reason is required' }, 400);
  return context.json(crews.exited(executionCredential(context.req.header('Authorization')), body.reason));
});
app.post('/shutdown', (context) => {
  if (context.req.header('Authorization') !== `Bearer ${token}`) return context.json({ error: 'Unauthorized' }, 401);
  setImmediate(shutdown);
  return context.json({ status: 'stopping' });
});

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, async (address) => {
  url = `http://127.0.0.1:${address.port}`;
  const temporary = join(directory, `daemon-${bootId}.json`);
  try {
    await writeFile(temporary, JSON.stringify({ pid: process.pid, bootId, url, token }), { mode: 0o600 });
    await rename(temporary, join(directory, 'daemon.json'));
  } catch (error) {
    console.error(error);
    shutdown();
    process.exitCode = 1;
  }
}) as Server;
server.on('error', (error) => {
  console.error(error);
  shutdown();
  process.exitCode = 1;
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  const drainDeadline = setTimeout(() => server.closeAllConnections(), 1000);
  drainDeadline.unref();
  server.close(async () => {
    clearTimeout(drainDeadline);
    await crews.drain();
    db.prepare('UPDATE daemon_lifecycle SET pid = NULL, stopped_at = ? WHERE singleton = 1 AND boot_id = ?')
      .run(new Date().toISOString(), bootId);
    db.close();
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
