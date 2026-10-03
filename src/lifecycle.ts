import { spawn } from 'node:child_process';
import { mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { processAlive, readDiscovery, type Discovery } from './state.js';

export interface DaemonStatus {
  status: 'running' | 'stopping' | 'stopped' | 'unresponsive';
  pid?: number;
  bootId?: string;
  url?: string;
  startedAt?: string;
  database?: { path: string; instanceId: string; bootCount: number; migrations: { name: string }[] };
}

export async function inspect(directory: string): Promise<DaemonStatus> {
  return inspectDiscovery(await readDiscovery(directory));
}

async function inspectDiscovery(discovery: Discovery | undefined): Promise<DaemonStatus> {
  if (!discovery || !processAlive(discovery.pid)) return { status: 'stopped' };
  try {
    const response = await fetch(`${discovery.url}/status`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error('Daemon status unavailable');
    const status = await response.json() as DaemonStatus;
    if (status.bootId !== discovery.bootId || status.pid !== discovery.pid || status.url !== discovery.url
      || !['running', 'stopping'].includes(status.status)) throw new Error('Daemon identity mismatch');
    return status;
  } catch {
    return { status: 'unresponsive', pid: discovery.pid, url: discovery.url };
  }
}

export async function start(directory: string): Promise<DaemonStatus> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await realpath(directory);
  const current = await inspect(directory);
  if (current.status === 'running') return current;
  if (current.status !== 'stopped') throw new Error(`Daemon is ${current.status}; refusing to start a replacement.`);
  const log = await open(join(directory, 'daemon.log'), 'a', 0o600);
  let failure: string | undefined;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./daemon.js', import.meta.url)), directory], {
    detached: true, stdio: ['ignore', log.fd, log.fd],
  });
  child.on('error', (error) => { failure = error.message; });
  child.on('exit', (code) => { failure = `Daemon exited with code ${code}. See ${join(directory, 'daemon.log')}.`; });
  child.unref();
  await log.close();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const status = await inspect(directory);
    if (status.status === 'running') return status;
    await delay(100);
  }
  throw new Error(failure ?? `Daemon did not become ready. See ${join(directory, 'daemon.log')}; do not blindly retry.`);
}

export async function stop(directory: string): Promise<DaemonStatus> {
  const discovery = await readDiscovery(directory);
  if (!discovery) return { status: 'stopped' };
  const current = await inspectDiscovery(discovery);
  if (current.status === 'stopped') return current;
  if (current.status === 'unresponsive') throw new Error('Daemon is unresponsive; refusing to signal an unverified process.');
  const response = await fetch(`${discovery.url}/shutdown`, {
    method: 'POST', headers: { Authorization: `Bearer ${discovery.token}` }, signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Daemon shutdown failed: HTTP ${response.status}`);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!processAlive(discovery.pid)) return { status: 'stopped' };
    await delay(100);
  }
  throw new Error('Daemon has not exited after shutdown; inspect its log before retrying.');
}
