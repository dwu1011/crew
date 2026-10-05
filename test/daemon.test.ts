import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';

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
