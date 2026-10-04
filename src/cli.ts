#!/usr/bin/env node
import { Command } from 'commander';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect, start, stop } from './lifecycle.js';

const program = new Command().name('crew').description('Local agent crew coordinator')
  .option('--state-dir <directory>', 'Daemon state directory', process.env.CREW_HOME ?? join(homedir(), '.crew'));
const daemon = program.command('daemon').description('Manage the local coordinator');
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
