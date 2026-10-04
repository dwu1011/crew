#!/usr/bin/env node
import { Command } from 'commander';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect, start, stop } from './lifecycle.js';
import { request } from './client.js';

const program = new Command().name('crew').description('Local agent crew coordinator')
  .option('--state-dir <directory>', 'Daemon state directory', process.env.CREW_HOME ?? join(homedir(), '.crew'));
const daemon = program.command('daemon').description('Manage the local coordinator');
program.command('up <configuration>').description('Launch configured Claude Code seats')
  .option('--json', 'Machine-readable output').action(async (configuration: string, options: { json?: boolean }) => {
    const directory = resolve(program.opts<{ stateDir: string }>().stateDir);
    await start(directory);
    const result = await request(directory, '/crews/up', { configPath: resolve(configuration) });
    if (options.json) console.log(JSON.stringify(result));
    else console.log(JSON.stringify(result, null, 2));
    if (result.seats.some((seat: { status: string }) => seat.status === 'failed')) process.exitCode = 1;
  });
for (const [name, path, description] of [
  ['status', '/crews', 'Inspect a configured crew'],
  ['members', '/members', 'Discover crew members and their roles'],
]) {
  program.command(name).description(description)
    .option('--crew <name>', 'Crew name; managed executions use their own crew').option('--json', 'Machine-readable output')
    .action(async (options: { crew?: string; json?: boolean }) => {
      const query = options.crew ? `?crew=${encodeURIComponent(options.crew)}` : '';
      const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), `${path}${query}`, undefined, process.env.CREW_EXECUTION_TOKEN);
      console.log(JSON.stringify(result, null, options.json ? undefined : 2));
      if (name === 'status' && result.status === 'failed') process.exitCode = 1;
    });
}
program.command('whoami').description('Verify the calling managed execution')
  .option('--json', 'Machine-readable output').action(async (options: { json?: boolean }) => {
    if (!process.env.CREW_EXECUTION_TOKEN) throw new Error('crew whoami requires a managed execution credential.');
    const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), '/whoami', undefined, process.env.CREW_EXECUTION_TOKEN);
    console.log(JSON.stringify(result, null, options.json ? undefined : 2));
  });
for (const [name, operation] of Object.entries({ start, status: inspect, stop })) {
  daemon.command(name).option('--json', 'Machine-readable output').action(async (options: { json?: boolean }) => {
    const directory = resolve(program.opts<{ stateDir: string }>().stateDir);
    const result = await operation(directory);
    if (options.json) console.log(JSON.stringify(result));
    else console.log(`Daemon ${result.status}${result.pid ? ` (PID ${result.pid})` : ''}${result.url ? ` at ${result.url}` : ''}.`);
    if (name === 'status' && result.status !== 'running') process.exitCode = 1;
  });
}
try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
