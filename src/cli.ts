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
interface RunOptions { crew?: string; profile?: string; project?: string }
function selection(options: RunOptions) {
  return { crew: options.crew, profile: options.profile,
    project: options.project ? resolve(options.project) : process.env.CREW_EXECUTION_TOKEN ? undefined : process.cwd() };
}
function selectionQuery(options: RunOptions) {
  return new URLSearchParams(Object.entries(selection(options)).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
function runOptions(command: Command) {
  return command.option('--crew <name>', 'Crew name; overrides project selection')
    .option('--profile <name>', 'Select a reusable profile run')
    .option('--project <directory>', 'Select a project; defaults to the current directory');
}
const daemon = program.command('daemon').description('Manage the local coordinator');
const profile = program.command('profile').description('Register and inspect reusable role definitions');
profile.command('register <source>').option('--json', 'Machine-readable output')
  .action(async (source: string, options: { json?: boolean }) => {
    const directory = resolve(program.opts<{ stateDir: string }>().stateDir);
    await start(directory);
    const result = await request(directory, '/profiles', { source: resolve(source) }, process.env.CREW_EXECUTION_TOKEN);
    console.log(JSON.stringify(result, null, options.json ? undefined : 2));
  });
profile.command('list').option('--json', 'Machine-readable output')
  .action(async (options: { json?: boolean }) => {
    const directory = resolve(program.opts<{ stateDir: string }>().stateDir);
    await start(directory);
    console.log(JSON.stringify(await request(directory, '/profiles', undefined, process.env.CREW_EXECUTION_TOKEN), null, options.json ? undefined : 2));
  });
profile.command('show <name>').option('--json', 'Machine-readable output')
  .action(async (name: string, options: { json?: boolean }) => {
    const directory = resolve(program.opts<{ stateDir: string }>().stateDir);
    await start(directory);
    console.log(JSON.stringify(await request(directory, `/profiles/${encodeURIComponent(name)}`, undefined, process.env.CREW_EXECUTION_TOKEN), null, options.json ? undefined : 2));
  });
for (const mode of ['send', 'reply'] as const) runOptions(program.command(mode === 'send' ? 'send <seat>' : 'reply <id>').description(mode === 'send' ? 'Persist a message and queue terminal delivery' : 'Reply and acknowledge the original as its recipient')).option('--text <body>', 'Literal message body')
  .option('--body-file <path>', 'Read body from a file; - reads standard input')
  .option('--request-id <id>', 'Reuse this identifier to recover a submission').option('--json', 'Machine-readable output')
  .action(async (seat: string, options: RunOptions & { text?: string; bodyFile?: string; requestId?: string; json?: boolean }) => {
    if ((options.text !== undefined) === (options.bodyFile !== undefined)) throw new Error('Provide exactly one of --text or --body-file.');
    let body = options.text;
    if (options.bodyFile === '-') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      body = Buffer.concat(chunks).toString('utf8');
    } else if (options.bodyFile !== undefined) body = await readFile(options.bodyFile, 'utf8');
    const requestId = options.requestId ?? randomUUID();
    console.error(`Submission request ID: ${requestId}. Reuse --request-id ${requestId} to recover this submission.`);
    const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), mode === 'send' ? '/messages' : `/messages/${encodeURIComponent(seat)}/reply`,
      { ...selection(options), ...(mode === 'send' ? { recipient: seat } : {}), body, requestId }, process.env.CREW_EXECUTION_TOKEN);
    console.log(JSON.stringify(result, null, options.json ? undefined : 2));
  });
runOptions(program.command('ack <id>').description('Acknowledge receipt as the current recipient execution')).option('--json', 'Machine-readable output')
  .action(async (id: string, options: RunOptions & { json?: boolean }) => {
    const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), `/messages/${encodeURIComponent(id)}/ack`,
      selection(options), process.env.CREW_EXECUTION_TOKEN);
    console.log(JSON.stringify(result, null, options.json ? undefined : 2));
  });
runOptions(program.command('inbox').description('Inspect incoming messages without acknowledging them')).option('--all', 'Include acknowledged history').option('--json', 'Machine-readable output')
  .action(async (options: RunOptions & { all?: boolean; json?: boolean }) => {
    const query = selectionQuery(options);
    if (options.all) query.set('all', 'true');
    const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), `/inbox?${query}`, undefined, process.env.CREW_EXECUTION_TOKEN);
    console.log(JSON.stringify(result, null, options.json ? undefined : 2));
  });
const messageCommands = program.command('message').description('Inspect and retry persisted messages');
runOptions(messageCommands.command('clear').description('Delete this crew’s messages and delivery attempts without stopping its agents')).option('--json', 'Machine-readable output')
  .action(async (options: RunOptions & { json?: boolean }) => {
    const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), '/messages/clear', selection(options), process.env.CREW_EXECUTION_TOKEN);
    console.log(JSON.stringify(result, null, options.json ? undefined : 2));
  });
runOptions(messageCommands.command('show <id>')).option('--json', 'Machine-readable output')
  .action(async (id: string, options: RunOptions & { json?: boolean }) => {
    const query = `?${selectionQuery(options)}`;
    const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), `/messages/${encodeURIComponent(id)}${query}`, undefined, process.env.CREW_EXECUTION_TOKEN);
    console.log(JSON.stringify(result, null, options.json ? undefined : 2));
  });
runOptions(messageCommands.command('retry <id>').description('Create a new attempt for failed or explicitly accepted uncertain delivery')).option('--allow-duplicate', 'Accept that uncertain delivery may produce a duplicate')
  .option('--json', 'Machine-readable output')
  .action(async (id: string, options: RunOptions & { allowDuplicate?: boolean; json?: boolean }) => {
    const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), `/messages/${encodeURIComponent(id)}/retry`,
      { ...selection(options), allowDuplicate: options.allowDuplicate ?? false }, process.env.CREW_EXECUTION_TOKEN);
    console.log(JSON.stringify(result, null, options.json ? undefined : 2));
  });
for (const [name, path] of [['feature', '/features'], ['task', '/tasks']] as const) {
  const commands = program.command(name).description(`Manage durable ${name} records`);
  runOptions(commands.command('list')).option('--feature <id>', 'Filter tasks by feature').option('--json', 'Machine-readable output')
    .action(async (options: RunOptions & { feature?: string; json?: boolean }) => {
      const query = selectionQuery(options);
      if (options.feature) query.set('featureId', options.feature);
      console.log(JSON.stringify(await request(resolve(program.opts<{ stateDir: string }>().stateDir), `${path}?${query}`, undefined,
        process.env.CREW_EXECUTION_TOKEN), null, options.json ? undefined : 2));
    });
  runOptions(commands.command('show <id>')).option('--json', 'Machine-readable output')
    .action(async (id: string, options: RunOptions & { json?: boolean }) => {
      console.log(JSON.stringify(await request(resolve(program.opts<{ stateDir: string }>().stateDir), `${path}/${encodeURIComponent(id)}?${selectionQuery(options)}`,
        undefined, process.env.CREW_EXECUTION_TOKEN), null, options.json ? undefined : 2));
    });
  runOptions(commands.command('create')).requiredOption('--input-file <path>', 'JSON feature or task contract')
    .option('--request-id <id>', 'Recover this mutation with the same identifier').option('--json', 'Machine-readable output')
    .action(async (options: RunOptions & { inputFile: string; requestId?: string; json?: boolean }) => {
      const input = JSON.parse(await readFile(options.inputFile, 'utf8'));
      const requestId = options.requestId ?? randomUUID();
      console.error(`Mutation request ID: ${requestId}. Reuse --request-id ${requestId} to recover this mutation.`);
      console.log(JSON.stringify(await request(resolve(program.opts<{ stateDir: string }>().stateDir), path,
        { ...selection(options), input, requestId }, process.env.CREW_EXECUTION_TOKEN), null, options.json ? undefined : 2));
    });
  for (const action of ['ready', 'pause', 'resume', 'cancel', 'grant'] as const) {
    if ((name === 'feature' && action === 'ready') || (name === 'task' && action === 'grant')) continue;
    const command = runOptions(commands.command(`${action} <id>`))
      .requiredOption('--expected-version <number>', 'Version returned by show')
      .requiredOption('--reason <text>', 'Reason for this change')
      .option('--request-id <id>', 'Recover this mutation with the same identifier').option('--json', 'Machine-readable output');
    if (action === 'grant') command.requiredOption('--execution <id>', 'Current execution to grant planning authority').option('--revoke', 'Revoke its planning authority');
    command.action(async (id: string, options: RunOptions & { expectedVersion: string; reason: string; requestId?: string; json?: boolean; execution?: string; revoke?: boolean }) => {
      const requestId = options.requestId ?? randomUUID();
      console.error(`Mutation request ID: ${requestId}. Reuse --request-id ${requestId} to recover this mutation.`);
      console.log(JSON.stringify(await request(resolve(program.opts<{ stateDir: string }>().stateDir), `${path}/${encodeURIComponent(id)}/${action}`,
        { ...selection(options), requestId, expectedVersion: Number(options.expectedVersion), reason: options.reason,
          ...(action === 'grant' ? { input: { executionId: options.execution, enabled: !options.revoke } } : {}) }, process.env.CREW_EXECUTION_TOKEN),
        null, options.json ? undefined : 2));
    });
  }
}
program.command('up [configuration]').description('Launch configured Claude Code seats or a reusable profile')
  .option('--profile <name>', 'Reusable profile name').option('--project <directory>', 'Project root; defaults to the current directory')
  .option('--json', 'Machine-readable output').action(async (configuration: string | undefined, options: { profile?: string; project?: string; json?: boolean }) => {
    if ((configuration !== undefined) === (options.profile !== undefined) || (configuration && options.project)) throw new Error('Provide either a configuration path or --profile <name> with optional --project <directory>.');
    const directory = resolve(program.opts<{ stateDir: string }>().stateDir);
    await start(directory);
    const result = await request(directory, '/crews/up', configuration ? { configPath: resolve(configuration) } : { profile: options.profile, project: resolve(options.project ?? process.cwd()) }, process.env.CREW_EXECUTION_TOKEN);
    if (options.json) console.log(JSON.stringify(result));
    else console.log(JSON.stringify(result, null, 2));
    if (result.seats.some((seat: { status: string }) => seat.status === 'failed')) process.exitCode = 1;
  });
runOptions(program.command('down').description('Stop one crew and clear its messages; retain execution history')).option('--json', 'Machine-readable output')
  .action(async (options: RunOptions & { json?: boolean }) => {
    const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), '/crews/down', selection(options), process.env.CREW_EXECUTION_TOKEN);
    console.log(JSON.stringify(result, null, options.json ? undefined : 2));
  });
for (const [name, path, description] of [
  ['status', '/crews', 'Inspect a configured crew'],
  ['members', '/members', 'Discover crew members and their roles'],
]) {
  runOptions(program.command(name).description(description)).option('--json', 'Machine-readable output')
    .action(async (options: RunOptions & { json?: boolean }) => {
      const query = `?${selectionQuery(options)}`;
      const result = await request(resolve(program.opts<{ stateDir: string }>().stateDir), `${path}${query}`, undefined, process.env.CREW_EXECUTION_TOKEN);
      console.log(JSON.stringify(result, null, options.json ? undefined : 2));
      if (name === 'status' && ['failed', 'unknown'].includes(result.status)) process.exitCode = 1;
    });
}
for (const name of ['attach', 'detach']) {
  runOptions(program.command(`${name} [seat]`).description(`${name === 'attach' ? 'Enter' : 'Disconnect from'} a seat or the entire crew`))
    .action(async (seatName: string | undefined, options: RunOptions) => {
      const query = `?${selectionQuery(options)}`;
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
