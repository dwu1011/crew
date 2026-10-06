import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const homes: string[] = [];
const ownedPids = new Map<string, Set<number>>();

async function cli(home: string, ...args: string[]) {
  try {
    return await exec(process.execPath, [resolve('dist/cli.js'), '--state-dir', home, 'daemon', ...args], { timeout: 15000 });
  } finally {
    if (args[0] === 'start') {
      const record = await readFile(join(home, 'daemon.json'), 'utf8').catch(() => undefined);
      if (record) {
        const { pid } = JSON.parse(record);
        if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
          const pids = ownedPids.get(home) ?? new Set<number>();
          pids.add(pid);
          ownedPids.set(home, pids);
        }
      }
    }
  }
}

async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'crew-test-'));
  homes.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of homes.splice(0)) {
    await cli(directory, 'stop').catch(() => {});
    for (const pid of ownedPids.get(directory) ?? []) {
      try {
        process.kill(pid, 'SIGCONT');
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
        throw error;
      }
      await expect.poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          throw error;
        }
      }, { timeout: 5000 }).toBe(false);
    }
    ownedPids.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

test('a human can start, inspect, and stop a loopback daemon', async () => {
  const directory = await home();
  const started = JSON.parse((await cli(directory, 'start', '--json')).stdout);
  expect(started.status).toBe('running');
  expect(new URL(started.url).hostname).toBe('127.0.0.1');

  const status = JSON.parse((await cli(directory, 'status', '--json')).stdout);
  expect(status.pid).toBe(started.pid);
  const response = await fetch(`${started.url}/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'running', pid: started.pid });

  expect(JSON.parse((await cli(directory, 'stop', '--json')).stdout).status).toBe('stopped');
  await expect(fetch(`${started.url}/health`)).rejects.toThrow();
}, 20000);

test('restart preserves database identity and migrations while creating a new boot', async () => {
  const directory = await home();
  const first = JSON.parse((await cli(directory, 'start', '--json')).stdout);
  expect(first.database.migrations).toEqual([{ name: '001_daemon_lifecycle' }, { name: '002_single_seat' }, { name: '003_seat_roles' }, { name: '004_crew_lifecycle' }, { name: '005_durable_messages' }, { name: '006_terminal_delivery' }, { name: '007_message_receipts' }, { name: '009_delivery_retry' }, { name: '010_prompt_verification' }, { name: '011_runtime_activity' }]);
  await cli(directory, 'stop');
  expect(JSON.parse((await cli(directory, 'stop', '--json')).stdout).status).toBe('stopped');
  await expect(cli(directory, 'status', '--json')).rejects.toMatchObject({ code: 1, stdout: '{"status":"stopped"}\n' });
  const second = JSON.parse((await cli(directory, 'start', '--json')).stdout);
  expect(second.database.instanceId).toBe(first.database.instanceId);
  expect(second.database.bootCount).toBe(first.database.bootCount + 1);
  expect(second.database.migrations).toEqual(first.database.migrations);
  expect(second.bootId).not.toBe(first.bootId);
}, 20000);

test.each([5, 7])('startup upgrades historical schema %s without losing messages or attempts', async (version) => {
  const directory = await home();
  const instanceId = randomUUID();
  const crewId = randomUUID(), seatId = randomUUID(), executionId = randomUUID(), messageId = randomUUID();
  const failedAttempt = randomUUID(), pendingAttempt = randomUUID(), replyId = randomUUID();
  const createdAt = '2026-01-01T00:00:00.000Z';
  const db = new Database(join(directory, 'crew.sqlite'));
  try {
    db.exec(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE daemon_lifecycle (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), instance_id TEXT NOT NULL,
        pid INTEGER, boot_id TEXT, started_at TEXT, stopped_at TEXT, boot_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE crews (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, project TEXT NOT NULL, config_path TEXT NOT NULL, config_digest TEXT);
      CREATE TABLE seats (id TEXT PRIMARY KEY, crew_id TEXT NOT NULL REFERENCES crews(id), name TEXT NOT NULL,
        role_path TEXT NOT NULL, role TEXT, UNIQUE(crew_id, name));
      CREATE TABLE executions (id TEXT PRIMARY KEY, seat_id TEXT NOT NULL REFERENCES seats(id), generation TEXT NOT NULL UNIQUE,
        native_session_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('launching', 'ready', 'failed')), cwd TEXT NOT NULL,
        failure TEXT, context_path TEXT, tmux_session TEXT, tmux_pane TEXT, created_at TEXT NOT NULL, ready_at TEXT,
        state TEXT NOT NULL DEFAULT 'active', retryable INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX execution_one_active ON executions(seat_id) WHERE state = 'active' AND status IN ('launching', 'ready');
      CREATE TABLE messages (id TEXT PRIMARY KEY, crew_id TEXT NOT NULL REFERENCES crews(id), request_id TEXT NOT NULL,
        sender_key TEXT NOT NULL, sender_seat_id TEXT REFERENCES seats(id), sender_execution_id TEXT REFERENCES executions(id),
        recipient_seat_id TEXT ${version === 5 ? 'NOT NULL' : ''} REFERENCES seats(id), body TEXT NOT NULL, created_at TEXT NOT NULL,
        acknowledged_at TEXT ${version === 7 ? ', acknowledged_execution_id TEXT REFERENCES executions(id), reply_to TEXT REFERENCES messages(id)' : ''},
        UNIQUE(crew_id, sender_key, request_id));
      CREATE INDEX messages_inbox ON messages(recipient_seat_id, acknowledged_at);
      CREATE TABLE delivery_attempts (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
        execution_id TEXT REFERENCES executions(id), status TEXT NOT NULL, created_at TEXT NOT NULL, failure TEXT);
      CREATE INDEX delivery_pending ON delivery_attempts(status);`);
    const migrations = ['001_daemon_lifecycle', '002_single_seat', '003_seat_roles', '004_crew_lifecycle', '005_durable_messages'];
    if (version === 7) {
      db.exec(`ALTER TABLE executions ADD COLUMN runtime_version TEXT;
        ALTER TABLE delivery_attempts ADD COLUMN generation TEXT;
        ALTER TABLE delivery_attempts ADD COLUMN pane TEXT;
        ALTER TABLE delivery_attempts ADD COLUMN submitting_at TEXT;
        ALTER TABLE delivery_attempts ADD COLUMN submitted_at TEXT;
        CREATE INDEX messages_replies ON messages(reply_to);`);
      migrations.push('006_terminal_delivery', '007_message_receipts');
    }
    for (const name of migrations) db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(name, createdAt);
    db.prepare('INSERT INTO daemon_lifecycle (singleton, instance_id, boot_count) VALUES (1, ?, 4)').run(instanceId);
    db.prepare('INSERT INTO crews (id, name, project, config_path) VALUES (?, ?, ?, ?)').run(crewId, 'historical', directory, join(directory, 'crew.yaml'));
    db.prepare('INSERT INTO seats (id, crew_id, name, role_path, role) VALUES (?, ?, ?, ?, ?)').run(seatId, crewId, 'coder', join(directory, 'role.md'), 'Historical role');
    db.prepare("INSERT INTO executions (id, seat_id, generation, native_session_id, token_hash, status, cwd, created_at, state) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, 'stopped')")
      .run(executionId, seatId, randomUUID(), randomUUID(), 'old-token-hash', directory, createdAt);
    db.prepare('INSERT INTO messages (id, crew_id, request_id, sender_key, recipient_seat_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(messageId, crewId, 'historical-request', 'operator', seatId, 'Historical message', createdAt);
    db.prepare("INSERT INTO delivery_attempts (id, message_id, status, created_at, failure) VALUES (?, ?, 'failed', ?, 'Historical failure')").run(failedAttempt, messageId, createdAt);
    db.prepare("INSERT INTO delivery_attempts (id, message_id, status, created_at) VALUES (?, ?, 'pending', ?)").run(pendingAttempt, messageId, createdAt);
    if (version === 7) {
      db.prepare('UPDATE messages SET acknowledged_at = ?, acknowledged_execution_id = ? WHERE id = ?').run(createdAt, executionId, messageId);
      db.prepare('INSERT INTO messages (id, crew_id, request_id, sender_key, sender_seat_id, sender_execution_id, body, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(replyId, crewId, 'historical-reply', executionId, seatId, executionId, 'Historical reply', createdAt, messageId);
    }
  } finally { db.close(); }

  const started = JSON.parse((await cli(directory, 'start', '--json')).stdout);
  expect(started.database).toMatchObject({ instanceId, bootCount: 5 });
  expect(started.database.migrations).toHaveLength(10);
  const discovery = JSON.parse(await readFile(join(directory, 'daemon.json'), 'utf8'));
  const headers = { Authorization: `Bearer ${discovery.token}` };
  const crew = await (await fetch(`${started.url}/crews/historical`, { headers })).json();
  expect(crew).toMatchObject({ status: 'stopped', seats: [{ seatId, executionId, role: 'Historical role', nativeVersion: null, activity: null }] });
  const message = await (await fetch(`${started.url}/messages/${messageId}?crew=historical`, { headers })).json();
  expect(message).toMatchObject({ id: messageId, body: 'Historical message', createdAt,
    deliveries: [{ id: failedAttempt, status: 'failed', failure: 'Historical failure', promptVerification: null },
      { id: pendingAttempt, status: 'pending', promptVerification: null }] });
  if (version === 7) {
    expect(message).toMatchObject({ acknowledgment: { executionId, acknowledgedAt: createdAt }, replies: [{ id: replyId }] });
    const reply = await (await fetch(`${started.url}/messages/${replyId}?crew=historical`, { headers })).json();
    expect(reply).toMatchObject({ recipient: { kind: 'operator', seatId: null }, replyTo: messageId, body: 'Historical reply', deliveries: [] });
  }
  const reused = JSON.parse((await exec(process.execPath, [resolve('dist/cli.js'), '--state-dir', directory,
    'send', 'coder', '--crew', 'historical', '--text', 'Historical message', '--request-id', 'historical-request', '--json'])).stdout);
  expect(reused.id).toBe(messageId);
  expect(reused.deliveries.map((attempt: { id: string }) => attempt.id)).toEqual([failedAttempt, pendingAttempt]);
  await cli(directory, 'stop');
  const restarted = JSON.parse((await cli(directory, 'start', '--json')).stdout);
  expect(restarted.database).toMatchObject({ instanceId, bootCount: 6, migrations: started.database.migrations });
}, 20000);

test('a live unresponsive daemon is reported and never replaced', async () => {
  const directory = await home();
  const started = JSON.parse((await cli(directory, 'start', '--json')).stdout);
  process.kill(started.pid, 'SIGSTOP');
  try {
    await expect(cli(directory, 'status', '--json')).rejects.toMatchObject({ code: 1 });
    await expect(cli(directory, 'start')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('unresponsive') });
    await expect(cli(directory, 'stop')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('unresponsive') });
  } finally {
    process.kill(started.pid, 'SIGCONT');
  }
  expect(JSON.parse((await cli(directory, 'status', '--json')).stdout).bootId).toBe(started.bootId);
}, 20000);

test('HTTP health and status agree, and HTTP shutdown requires the local credential', async () => {
  const directory = await home();
  const started = JSON.parse((await cli(directory, 'start', '--json')).stdout);
  const health = await fetch(`${started.url}/health`);
  const status = await fetch(`${started.url}/status`);
  expect(await health.json()).toEqual(await status.json());
  const rejected = await fetch(`${started.url}/shutdown`, { method: 'POST' });
  expect(rejected.status).toBe(401);
  expect(await rejected.json()).toEqual({ error: 'Unauthorized' });
  expect((await fetch(`${started.url}/health`)).status).toBe(200);
  const discovery = JSON.parse(await readFile(join(directory, 'daemon.json'), 'utf8'));
  const accepted = await fetch(`${started.url}/shutdown`, {
    method: 'POST', headers: { Authorization: `Bearer ${discovery.token}` },
  });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ status: 'stopping' });
  await expect.poll(async () => {
    try {
      await fetch(`${started.url}/health`);
      return false;
    } catch {
      return true;
    }
  }).toBe(true);
}, 20000);

test('shutdown completes even when an HTTP client leaves its request unfinished', async () => {
  const directory = await home();
  const started = JSON.parse((await cli(directory, 'start', '--json')).stdout);
  const url = new URL(started.url);
  const socket = connect(Number(url.port), url.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  try {
    const stopped = JSON.parse((await cli(directory, 'stop', '--json')).stdout);
    expect(stopped.status).toBe('stopped');
  } finally {
    socket.destroy();
  }
}, 20000);

test('concurrent starts all reuse one healthy instance', async () => {
  const directory = await home();
  const results = await Promise.all(Array.from({ length: 6 }, () => cli(directory, 'start', '--json')));
  const statuses = results.map((result) => JSON.parse(result.stdout));
  expect(new Set(statuses.map((status) => status.pid)).size).toBe(1);
  expect(new Set(statuses.map((status) => status.bootId)).size).toBe(1);
  const repeated = JSON.parse((await cli(directory, 'start', '--json')).stdout);
  expect(repeated.bootId).toBe(statuses[0].bootId);
}, 20000);

test('shutdown stays bound to the daemon identity verified before discovery changes', async () => {
  const directory = await home();
  let predecessorRequests = 0;
  let successorRequests = 0;
  const successor = createServer((_request, response) => {
    successorRequests++;
    response.writeHead(409).end();
  });
  await new Promise<void>((resolve) => successor.listen(0, '127.0.0.1', resolve));
  const successorPort = (successor.address() as { port: number }).port;
  const replacement = { pid: process.pid, bootId: 'successor', url: `http://127.0.0.1:${successorPort}`, token: 'successor-token' };
  const predecessor = createServer(async (request, response) => {
    if (request.url === '/status') {
      await writeFile(join(directory, 'daemon.json'), JSON.stringify(replacement));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ...original, status: 'running' }));
    } else {
      predecessorRequests++;
      response.writeHead(409).end();
    }
  });
  await new Promise<void>((resolve) => predecessor.listen(0, '127.0.0.1', resolve));
  const predecessorPort = (predecessor.address() as { port: number }).port;
  const original = { pid: process.pid, bootId: 'predecessor', url: `http://127.0.0.1:${predecessorPort}`, token: 'predecessor-token' };
  await writeFile(join(directory, 'daemon.json'), JSON.stringify(original));
  try {
    await expect(cli(directory, 'stop')).rejects.toMatchObject({ code: 1 });
    expect(successorRequests).toBe(0);
    expect(predecessorRequests).toBe(1);
  } finally {
    await Promise.all([predecessor, successor].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}, 20000);
