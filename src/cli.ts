#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { inspect, start, stop } from './lifecycle.js';
import { request } from './client.js';
import { attachCrew, attachSession, detachCrew } from './terminal.js';

const program = new Command().name('crew').description('Local agent crew coordinator')
  .option('--state-dir <directory>', 'Daemon state directory', process.env.CREW_HOME ?? join(homedir(), '.crew'));
const daemon = program.command('daemon').description('Manage the local coordinator');
program.command('send <seat>').description('Persist a message and queue terminal delivery')
  .option('--crew <name>', 'Crew name').option('--text <body>', 'Literal message body')
  .option('--body-file <path>', 'Read body from a file; - reads standard input')
  .option('--request-id <id>', 'Reuse this identifier to recover a submission').option('--json', 'Machine-readable output')
  .action(async (seat: string, options: { crew?: string; text?: string; bodyFile?: string; requestId?: string; json?: boolean }) => {
    if ((options.text !== undefined) === (options.bodyFile !== undefined)) throw new Error('Provide exactly one of --text or --body-file.');
    let body = options.text;
    if (options.bodyFile === '-') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      body = Buffer.concat(chunks).toString('utf8');
    } else if (options.bodyFile !== undefined) body = await readFile(options.bodyFile, 'utf8');
    const requestId = options.requestId ?? randomUUID();
    console.error(`Submission request ID: ${requestId}. Reuse --request-id ${requestId} to recover this submission.`);
    const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), '/messages',
      { crew: options.crew, recipient: seat, body, requestId }, process.env.CREW_EXECUTION_TOKEN);
    console.log(JSON.stringify(result, null, options.json ? undefined : 2));
  });
program.command('inbox').description('Inspect incoming messages without acknowledging them')
  .option('--crew <name>', 'Crew name').option('--all', 'Include acknowledged history').option('--json', 'Machine-readable output')
  .action(async (options: { crew?: string; all?: boolean; json?: boolean }) => {
    const query = new URLSearchParams({ ...(options.crew ? { crew: options.crew } : {}), ...(options.all ? { all: 'true' } : {}) });
    const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), `/inbox?${query}`, undefined, process.env.CREW_EXECUTION_TOKEN);
    console.log(JSON.stringify(result, null, options.json ? undefined : 2));
  });
program.command('message').description('Inspect persisted messages').command('show <id>')
  .option('--crew <name>', 'Crew name').option('--json', 'Machine-readable output')
  .action(async (id: string, options: { crew?: string; json?: boolean }) => {
    const query = options.crew ? `?crew=${encodeURIComponent(options.crew)}` : '';
    const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), `/messages/${encodeURIComponent(id)}${query}`, undefined, process.env.CREW_EXECUTION_TOKEN);
    console.log(JSON.stringify(result, null, options.json ? undefined : 2));
  });
program.command('up <configuration>').description('Launch configured Claude Code seats')
  .option('--json', 'Machine-readable output').action(async (configuration: string, options: { json?: boolean }) => {
    const directory = resolve(program.opts<{ stateDir: string }>().stateDir);
    await start(directory);
    const result = await request(directory, '/crews/up', { configPath: resolve(configuration) });
    if (options.json) console.log(JSON.stringify(result));
    else console.log(JSON.stringify(result, null, 2));
    if (result.seats.some((seat: { status: string }) => seat.status === 'failed')) process.exitCode = 1;
  });
program.command('down').description('Stop one crew while retaining execution history')
  .requiredOption('--crew <name>', 'Crew name').option('--json', 'Machine-readable output')
  .action(async (options: { crew: string; json?: boolean }) => {
    const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), '/crews/down', { crew: options.crew }, process.env.CREW_EXECUTION_TOKEN);
    console.log(JSON.stringify(result, null, options.json ? undefined : 2));
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
      if (name === 'status' && ['failed', 'unknown'].includes(result.status)) process.exitCode = 1;
    });
}
for (const name of ['attach', 'detach']) {
  program.command(`${name} [seat]`).description(`${name === 'attach' ? 'Enter' : 'Disconnect from'} a seat or the entire crew`)
    .option('--crew <name>', 'Crew name; required when multiple crews exist')
    .action(async (seatName: string | undefined, options: { crew?: string }) => {
      const query = options.crew ? `?crew=${encodeURIComponent(options.crew)}` : '';
      const directory = resolve(program.opts<{ stateDir: string }>().stateDir);
      const crew = await request(directory, `/crews${query}`, undefined, process.env.CREW_EXECUTION_TOKEN);
      if (!seatName) {
        await (name === 'attach' ? attachCrew : detachCrew)(directory, crew);
        return;
      }
      const seat = crew.seats.find((seat: { name: string }) => seat.name === seatName);
      if (!seat) throw new Error(`Unknown seat ${seatName} in crew ${crew.name}. Available seats: ${crew.seats.map((seat: { name: string }) => seat.name).join(', ')}`);
      if (!seat.tmux?.session || !['launching', 'ready'].includes(seat.status)) throw new Error(`Seat ${seatName} has no active terminal (${seat.status}).`);
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
      console.log(`To detach from another shell, run: crew detach ${seatName} --crew ${crew.name}`);
      await attachSession(seat.tmux.socket, seat.tmux.session);
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
