import { readDiscovery } from './state.js';

export async function request(directory: string, path: string, body?: unknown, credential?: string, timeoutMs = 15000) {
  const discovery = await readDiscovery(directory);
  if (!discovery) throw new Error('Daemon is not running. Start it with crew daemon start.');
  const response = await fetch(`${discovery.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${credential ?? discovery.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Daemon request failed: HTTP ${response.status}`);
  return result;
}
