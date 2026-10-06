import { serve } from '@hono/node-server';
import { openDatabase } from './database.js';
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
const bootId = randomUUID();
const db = openDatabase(databasePath, bootId);

const token = randomBytes(32).toString('hex');
const app = new Hono();
const crews = new Crews(db, directory);
const messages = new Messages(db, crews, directory);
await crews.reconcileAll();
messages.start();
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
  const caller = { crew: context.req.param('name'), seatId: null, executionId: null };
  return context.json({ ...await crews.status(caller.crew), deliveryIssues: messages.issues(caller) });
});
const executionCredential = (header: string | undefined) => header?.startsWith('Bearer ') ? header.slice(7) : '';
function selectedCaller(header: string | undefined, requested: string | undefined) {
  if (header === `Bearer ${token}`) return { crew: crews.select(requested), seatId: null, executionId: null };
  const caller = crews.whoami(executionCredential(header));
  if (requested && requested !== caller.crew) throw new HTTPException(403, { message: 'Managed executions can only inspect their own crew' });
  return { crew: caller.crew, seatId: caller.seatId, executionId: caller.executionId };
}
app.get('/crews', async (context) => {
  const caller = selectedCaller(context.req.header('Authorization'), context.req.query('crew'));
  return context.json({ ...await crews.status(caller.crew), deliveryIssues: messages.issues(caller) });
});
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
  const message = messages.send(selectedCaller(context.req.header('Authorization'), body.crew), body.recipient, body.body, body.requestId);
  return context.json(message);
});
app.post('/messages/:id/retry', async (context) => {
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const parsed = z.object({ crew: z.string().min(1).optional(), allowDuplicate: z.boolean().default(false) }).strict().safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Expected boolean allowDuplicate and optional crew only' }, 400);
  return context.json(messages.retry(selectedCaller(context.req.header('Authorization'), parsed.data.crew), context.req.param('id'), parsed.data.allowDuplicate));
});
app.post('/messages/:id/reply', async (context) => {
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const parsed = z.object({ crew: z.string().min(1).optional(), body: z.string(), requestId: z.string().min(1).max(200) }).strict().safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Expected body, requestId, and optional crew only' }, 400);
  const message = messages.reply(selectedCaller(context.req.header('Authorization'), parsed.data.crew), context.req.param('id'), parsed.data.body, parsed.data.requestId);
  return context.json(message);
});
app.post('/messages/:id/ack', async (context) => {
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const parsed = z.object({ crew: z.string().min(1).optional() }).strict().safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Expected optional crew only' }, 400);
  return context.json(messages.ack(selectedCaller(context.req.header('Authorization'), parsed.data.crew), context.req.param('id')));
});
app.get('/messages/:id', (context) => context.json(messages.show(selectedCaller(context.req.header('Authorization'), context.req.query('crew')), context.req.param('id'))));
app.get('/inbox', (context) => context.json(messages.inbox(selectedCaller(context.req.header('Authorization'), context.req.query('crew')), context.req.query('all') === 'true')));
app.get('/whoami', (context) => context.json(crews.whoami(executionCredential(context.req.header('Authorization')))));
app.post('/executions/activity', async (context) => {
  const caller = crews.whoami(executionCredential(context.req.header('Authorization')));
  const parsed = z.object({ event: z.enum(['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']), eventAt: z.string().datetime(), sessionId: z.string(), cwd: z.string(), toolName: z.string().optional() }).strict().safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Expected native activity event, timestamp, session, and cwd' }, 400);
  if (caller.nativeSessionId !== parsed.data.sessionId || caller.cwd !== parsed.data.cwd) return context.json({ error: 'Native activity identity mismatch' }, 403);
  if (Date.parse(parsed.data.eventAt) > Date.now() + 10000) return context.json({ error: 'Native event timestamp is in the future' }, 400);
  return context.json(crews.recordActivity(caller.executionId, parsed.data.event, parsed.data.eventAt, parsed.data.toolName));
});
app.post('/executions/prompt', async (context) => {
  const caller = crews.whoami(executionCredential(context.req.header('Authorization')));
  const parsed = z.object({ attemptId: z.string().uuid(), sessionId: z.string(), cwd: z.string(), prompt: z.string(), nativePromptId: z.string().min(1).max(200).optional(), eventAt: z.string().datetime().optional() }).strict().safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Expected delivery attempt, native session, cwd, and submitted prompt' }, 400);
  return context.json(messages.verifyPrompt(caller, parsed.data));
});
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
  const delivering = messages.stop();
  const drainDeadline = setTimeout(() => server.closeAllConnections(), 1000);
  drainDeadline.unref();
  server.close(async () => {
    clearTimeout(drainDeadline);
    await crews.drain();
    await delivering;
    db.prepare('UPDATE daemon_lifecycle SET pid = NULL, stopped_at = ? WHERE singleton = 1 AND boot_id = ?')
      .run(new Date().toISOString(), bootId);
    db.close();
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
