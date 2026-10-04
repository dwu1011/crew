#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
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
for (const name of ['attach', 'detach']) {
  program.command(`${name} <seat>`).description(`${name === 'attach' ? 'Enter' : 'Disconnect clients from'} a seat's terminal`)
    .option('--crew <name>', 'Crew name; required when multiple crews exist')
    .action(async (seatName: string, options: { crew?: string }) => {
      const query = options.crew ? `?crew=${encodeURIComponent(options.crew)}` : '';
      const crew = await request(resolve(program.opts<{ stateDir: string }>().stateDir), `/crews${query}`, undefined, process.env.CREW_EXECUTION_TOKEN);
      const seat = crew.seats.find((seat: { name: string }) => seat.name === seatName);
      if (!seat) throw new Error(`Unknown seat ${seatName} in crew ${crew.name}. Available seats: ${crew.seats.map((seat: { name: string }) => seat.name).join(', ')}`);
      if (!seat.tmux?.session || seat.status === 'failed') throw new Error(`Seat ${seatName} has no active terminal (${seat.status}).`);
      if (name === 'detach') {
        try {
          await promisify(execFile)('tmux', ['-S', seat.tmux.socket, 'detach-client', '-s', `=${seat.tmux.session}`], { timeout: 5000 });
        } catch (error) {
          if ((error as { stderr?: string }).stderr?.trim() !== 'no current client') throw error;
          console.log(`${seatName} in crew ${crew.name} is already detached. The agent keeps running.`);
          return;
        }
        console.log(`Detached ${seatName} in crew ${crew.name}. The agent keeps running.`);
        return;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('crew attach requires an interactive terminal.');
      const env = { ...process.env };
      delete env.TMUX;
      delete env.TMUX_PANE;
      console.log(`To detach from another shell, run: crew detach ${seatName} --crew ${crew.name}`);
      const child = spawn('tmux', ['-S', seat.tmux.socket, 'attach-session', '-t', `=${seat.tmux.session}`], { stdio: 'inherit', env });
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => { process.exitCode = code ?? 1; resolve(); });
      });
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
