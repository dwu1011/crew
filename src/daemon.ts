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
import { Profiles, type RunSelector } from './profiles.js';
import { Work, featureInputSchema, taskInputSchema, grantInputSchema, mutationSchema, createRequestSchema } from './work.js';

process.umask(0o077);
const directory = resolve(process.argv[2]);
await mkdir(directory, { recursive: true, mode: 0o700 });
const databasePath = join(directory, 'crew.sqlite');
const bootId = randomUUID();
const db = openDatabase(databasePath, bootId);

const token = randomBytes(32).toString('hex');
const app = new Hono();
const crews = new Crews(db, directory);
const profiles = new Profiles(db);
const work = new Work(db);
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
  const parsed = z.union([
    z.object({ configPath: z.string().refine(isAbsolute, 'configPath must be an absolute path') }).strict(),
    z.object({ profile: z.string().min(1), project: z.string().refine(isAbsolute, 'project must be an absolute path') }).strict(),
  ]).safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Provide either an absolute configPath or a profile and absolute project path' }, 400);
  const body = parsed.data;
  return context.json(await ('configPath' in body ? crews.launch(body.configPath) : crews.launchProfile(body.profile, body.project)));
});
app.get('/profiles', (context) => {
  if (context.req.header('Authorization') !== `Bearer ${token}`) return context.json({ error: 'Unauthorized' }, 401);
  return context.json(profiles.list());
});
app.get('/profiles/:name', async (context) => {
  if (context.req.header('Authorization') !== `Bearer ${token}`) return context.json({ error: 'Unauthorized' }, 401);
  return context.json(await profiles.show(context.req.param('name')));
});
app.post('/profiles', async (context) => {
  if (context.req.header('Authorization') !== `Bearer ${token}`) return context.json({ error: 'Unauthorized' }, 401);
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const parsed = z.object({ source: z.string().refine(isAbsolute) }).strict().safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'source must be an absolute profile definition path' }, 400);
  return context.json(await profiles.register(parsed.data.source));
});
app.get('/crews/:name', async (context) => {
  if (context.req.header('Authorization') !== `Bearer ${token}`) return context.json({ error: 'Unauthorized' }, 401);
  const caller = { crew: context.req.param('name'), seatId: null, executionId: null };
  return context.json({ ...await crews.status(caller.crew), deliveryIssues: messages.issues(caller) });
});
const executionCredential = (header: string | undefined) => header?.startsWith('Bearer ') ? header.slice(7) : '';
const selectorShape = { crew: z.string().min(1).optional(), profile: z.string().min(1).optional(),
  project: z.string().refine(isAbsolute, 'project must be an absolute path').optional() };
const selectorSchema = z.object(selectorShape).strict();
function querySelector(query: Record<string, string>) {
  const parsed = selectorSchema.safeParse({ crew: query.crew, profile: query.profile, project: query.project });
  if (!parsed.success) throw new HTTPException(400, { message: 'Invalid crew, profile, or absolute project selector' });
  return parsed.data;
}
async function selectedCaller(header: string | undefined, requested: RunSelector) {
  if (header === `Bearer ${token}`) return { crew: requested.project || requested.profile
    ? await profiles.select(requested) ?? crews.select(requested.crew) : crews.select(requested.crew), seatId: null, executionId: null };
  const caller = crews.whoami(executionCredential(header));
  await profiles.assertScope(caller.crew, requested);
  const current = crews.whoami(executionCredential(header));
  return { crew: current.crew, seatId: current.seatId, executionId: current.executionId };
}
for (const kind of ['features', 'tasks'] as const) {
  app.get(`/${kind}`, async (context) => {
    const caller = await selectedCaller(context.req.header('Authorization'), querySelector(context.req.query()));
    return context.json(kind === 'features' ? work.listFeatures(caller) : work.listTasks(caller, context.req.query('featureId')));
  });
  app.get(`/${kind}/:id`, async (context) => {
    const caller = await selectedCaller(context.req.header('Authorization'), querySelector(context.req.query()));
    return context.json(kind === 'features' ? work.showFeature(caller, context.req.param('id')) : work.showTask(caller, context.req.param('id')));
  });
  app.post(`/${kind}`, async (context) => {
    if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
    const schema = z.object({ ...selectorShape, ...createRequestSchema.shape,
      input: kind === 'features' ? featureInputSchema : taskInputSchema }).strict();
    const parsed = schema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: parsed.error.message }, 400);
    const caller = await selectedCaller(context.req.header('Authorization'), parsed.data);
    return context.json(kind === 'features'
      ? work.createFeature(caller, featureInputSchema.parse(parsed.data.input), parsed.data.requestId)
      : work.createTask(caller, taskInputSchema.parse(parsed.data.input), parsed.data.requestId));
  });
  for (const action of ['ready', 'pause', 'resume', 'cancel'] as const) {
    if (kind === 'features' && action === 'ready') continue;
    app.post(`/${kind}/:id/${action}`, async (context) => {
      if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
      const parsed = z.object({ ...selectorShape, ...mutationSchema.shape }).strict().safeParse(await context.req.json());
      if (!parsed.success) return context.json({ error: parsed.error.message }, 400);
      const caller = await selectedCaller(context.req.header('Authorization'), parsed.data);
      const mutation = mutationSchema.parse({ requestId: parsed.data.requestId, expectedVersion: parsed.data.expectedVersion, reason: parsed.data.reason });
      return context.json(kind === 'features'
        ? work.featureAction(caller, context.req.param('id'), action as 'pause' | 'resume' | 'cancel', mutation)
        : work.taskAction(caller, context.req.param('id'), action, mutation));
    });
  }
}
app.post('/features/:id/grant', async (context) => {
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const parsed = z.object({ ...selectorShape, ...mutationSchema.shape, input: grantInputSchema }).strict().safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: parsed.error.message }, 400);
  const caller = await selectedCaller(context.req.header('Authorization'), parsed.data);
  return context.json(work.setGrant(caller, context.req.param('id'), parsed.data.input,
    mutationSchema.parse({ requestId: parsed.data.requestId, expectedVersion: parsed.data.expectedVersion, reason: parsed.data.reason })));
});
app.get('/crews', async (context) => {
  const caller = await selectedCaller(context.req.header('Authorization'), querySelector(context.req.query()));
  return context.json({ ...await crews.status(caller.crew), deliveryIssues: messages.issues(caller) });
});
app.post('/crews/down', async (context) => {
  if (context.req.header('Authorization') !== `Bearer ${token}`) return context.json({ error: 'Unauthorized' }, 401);
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const parsed = selectorSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Invalid crew, profile, or absolute project selector' }, 400);
  const caller = await selectedCaller(context.req.header('Authorization'), parsed.data);
  return context.json(await crews.down(caller.crew));
});
app.get('/members', async (context) => context.json(await crews.members((await selectedCaller(context.req.header('Authorization'), querySelector(context.req.query()))).crew)));
const submission = z.object({ ...selectorShape, recipient: z.string().min(1), body: z.string(), requestId: z.string().min(1).max(200) }).strict();
app.post('/messages', async (context) => {
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const parsed = submission.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Expected recipient, body, requestId, and optional crew/profile/project selectors only' }, 400);
  const body = parsed.data;
  const message = messages.send(await selectedCaller(context.req.header('Authorization'), body), body.recipient, body.body, body.requestId);
  return context.json(message);
});
app.post('/messages/clear', async (context) => {
  if (context.req.header('Authorization') !== `Bearer ${token}`) return context.json({ error: 'Unauthorized' }, 401);
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const parsed = selectorSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Expected optional crew/profile/project selectors only' }, 400);
  const caller = await selectedCaller(context.req.header('Authorization'), parsed.data);
  return context.json(await crews.clearMessages(caller.crew));
});
app.post('/messages/:id/retry', async (context) => {
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const parsed = z.object({ ...selectorShape, allowDuplicate: z.boolean().default(false) }).strict().safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Expected boolean allowDuplicate and optional crew/profile/project selectors only' }, 400);
  return context.json(messages.retry(await selectedCaller(context.req.header('Authorization'), parsed.data), context.req.param('id'), parsed.data.allowDuplicate));
});
app.post('/messages/:id/reply', async (context) => {
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const parsed = z.object({ ...selectorShape, body: z.string(), requestId: z.string().min(1).max(200) }).strict().safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Expected body, requestId, and optional crew/profile/project selectors only' }, 400);
  const message = messages.reply(await selectedCaller(context.req.header('Authorization'), parsed.data), context.req.param('id'), parsed.data.body, parsed.data.requestId);
  return context.json(message);
});
app.post('/messages/:id/ack', async (context) => {
  if (stopping) return context.json({ error: 'Daemon is stopping' }, 503);
  const parsed = selectorSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Expected optional crew/profile/project selectors only' }, 400);
  return context.json(messages.ack(await selectedCaller(context.req.header('Authorization'), parsed.data), context.req.param('id')));
});
app.get('/messages/:id', async (context) => context.json(messages.show(await selectedCaller(context.req.header('Authorization'), querySelector(context.req.query())), context.req.param('id'))));
app.get('/inbox', async (context) => context.json(messages.inbox(await selectedCaller(context.req.header('Authorization'), querySelector(context.req.query())), context.req.query('all') === 'true')));
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
app.post('/executions/session', async (context) => {
  const credential = executionCredential(context.req.header('Authorization'));
  crews.whoami(credential);
  const parsed = z.object({ source: z.enum(['clear', 'resume']), sessionId: z.string().uuid(), cwd: z.string() }).strict().safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'Expected clear/resume source, native session UUID, and cwd' }, 400);
  return context.json(await crews.sessionStarted(credential, parsed.data.sessionId, parsed.data.cwd, parsed.data.source));
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
