import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Discovery {
  pid: number;
  bootId: string;
  url: string;
  token: string;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

export async function readDiscovery(directory: string): Promise<Discovery | undefined> {
  let content: string;
  try {
    content = await readFile(join(directory, 'daemon.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value = JSON.parse(content) as Discovery;
  const url = new URL(value.url);
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.bootId !== 'string'
    || typeof value.token !== 'string' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid daemon discovery record; refusing to contact or replace it.');
  }
  return value;
}
