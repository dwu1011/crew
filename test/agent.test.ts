import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';

const exec = promisify(execFile);
const cliPath = resolve('dist/cli.js');
const fixtures: { directory: string; state: string }[] = [];

async function fixture(mode: 'normal' | 'hold' | 'exit' | 'discovery' = 'normal') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crew-seat-')));
  const state = join(directory, 'state');
  const project = join(directory, 'project with spaces');
  await mkdir(project);
  await writeFile(join(project, 'CLAUDE.md'), 'Project convention: report findings before editing.\n');
  await writeFile(join(directory, 'role.md'), 'You are an investigator. Inspect code and explain findings.\n');
  const config = join(directory, 'crew.yaml');
  await writeFile(config, 'name: sample\nproject: project with spaces\nagents:\n  investigator:\n    runtime: claude\n    role_file: role.md\n');
  fixtures.push({ directory, state });
  const binary = join(directory, 'fake-claude');
  await writeFile(binary, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('2.1.283 (Claude Code fixture)'); process.exit(0); }
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const prompt = readFileSync(option('--append-system-prompt-file'), 'utf8');
const settings = JSON.parse(readFileSync(option('--settings'), 'utf8'));
console.log('CREW_CONTEXT=' + JSON.stringify({ prompt, cwd: process.cwd(), args }));
writeFileSync(${JSON.stringify(join(directory, 'native-credential'))}, process.env.CREW_EXECUTION_TOKEN, { mode: 0o600 });
writeFileSync(${JSON.stringify(join(directory, 'credential-'))} + process.env.CREW_SEAT, process.env.CREW_EXECUTION_TOKEN, { mode: 0o600 });
if (${JSON.stringify(mode)} === 'exit') process.exit(11);
if (${JSON.stringify(mode)} === 'hold') { process.stdin.resume(); } else {
const hook = settings.hooks.SessionStart[0].hooks[0].command;
const result = spawnSync('/bin/sh', ['-c', hook], { input: JSON.stringify({ session_id: option('--session-id'), cwd: process.cwd() }), encoding: 'utf8' });
if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
const identity = spawnSync('crew', ['whoami', '--json'], { encoding: 'utf8' });
console.log('CREW_IDENTITY=' + identity.stdout.trim());
if (identity.status !== 0) { console.error(identity.stderr); process.exit(1); }
if (${JSON.stringify(mode)} === 'discovery') {
  const members = spawnSync('crew', ['members', '--json'], { encoding: 'utf8' });
  console.log('CREW_MEMBERS=' + members.stdout.trim());
  if (members.status !== 0) { console.error(members.stderr); process.exit(1); }
}
process.stdin.resume();
}
`);
  await chmod(binary, 0o700);
  return { directory, state, project, config, binary };
}

async function cli(state: string, ...args: string[]) {
  return exec(process.execPath, [cliPath, '--state-dir', state, ...args], { timeout: 15000 });
}

afterEach(async () => {
  for (const { directory, state } of fixtures.splice(0)) {
    await exec('tmux', ['-S', join(state, 'tmux.sock'), 'kill-server']).catch(() => {});
    const record = await readFile(join(state, 'daemon.json'), 'utf8').catch(() => undefined);
    await cli(state, 'daemon', 'stop').catch(() => {});
    if (record) {
      const { pid } = JSON.parse(record);
      try { process.kill(pid, 'SIGTERM'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await expect.poll(() => {
        try { process.kill(pid, 0); return true; } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          throw error;
        }
      }, { timeout: 5000 }).toBe(false);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid role and working-directory references launch no agents', async () => {
  const { state, config } = await fixture();
  await writeFile(config, 'name: sample\nproject: missing-project\nagents:\n  investigator:\n    runtime: claude\n    role_file: missing-role.md\n');
  await expect(cli(state, 'up', config, '--json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('project') });
  await expect(exec('tmux', ['-S', join(state, 'tmux.sock'), 'list-sessions'])).rejects.toThrow();
}, 20000);

test('a configured seat starts in tmux with role, project guidance, and authenticated identity', async () => {
  const { state, project, config, binary } = await fixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  const launched = JSON.parse((await cli(state, 'up', config, '--json')).stdout);
  expect(launched.name).toBe('sample');
  expect(launched.seats[0]).toMatchObject({ name: 'investigator', runtime: 'claude', cwd: project });
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--crew', 'sample', '--json')).stdout).seats[0].status,
    { timeout: 10000 }).toBe('ready');
  const seat = JSON.parse((await cli(state, 'status', '--crew', 'sample', '--json')).stdout).seats[0];
  expect(seat.executionId).toBeTruthy();
  expect(seat.generation).toBeTruthy();
  await expect.poll(async () => (await exec('tmux', ['-S', seat.tmux.socket, 'capture-pane', '-p', '-J', '-S', '-', '-t', seat.tmux.pane])).stdout,
    { timeout: 10000 }).toContain('CREW_IDENTITY=');
  const output = (await exec('tmux', ['-S', seat.tmux.socket, 'capture-pane', '-p', '-J', '-S', '-', '-t', seat.tmux.pane])).stdout;
  expect(output).toContain('You are an investigator');
  expect(output).toContain('Project convention: report findings before editing');
  expect(output).toContain('"seat":"investigator"');
  expect(output).toContain('"crew":"sample"');
  expect(output).toContain(seat.executionId);
  expect(output).toContain(seat.generation);
  expect(await readFile(join(project, 'CLAUDE.md'), 'utf8')).toBe('Project convention: report findings before editing.\n');
}, 25000);

test('native startup waits for the runner identity receipt before reporting ready', async () => {
  const { directory, state, config, binary } = await fixture();
  const ps = (await exec('which', ['ps'])).stdout.trim();
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'ps'), `#!${process.execPath}
const { spawnSync } = await import('node:child_process');
const args = process.argv.slice(2);
if (Number(args[args.indexOf('-p') + 1]) === process.ppid) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
process.exit(spawnSync(${JSON.stringify(ps)}, args, { stdio: 'inherit' }).status ?? 1);
`, { mode: 0o700 });
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary, PATH: `${bin}:${process.env.PATH}` }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json');
  await expect.poll(async () => {
    const result = await cli(state, 'status', '--json').catch((error: { stdout: string }) => error);
    return JSON.parse(result.stdout).status;
  }, { timeout: 5000 }).toBe('ready');
}, 20000);

test('a native process remains launching until its startup identity is confirmed', async () => {
  const { state, config, binary } = await fixture('hold');
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  const launched = JSON.parse((await cli(state, 'up', config, '--json')).stdout);
  expect(launched.seats[0].status).toBe('launching');
  const pane = launched.seats[0].tmux;
  await expect.poll(async () => (await exec('tmux', ['-S', pane.socket, 'capture-pane', '-p', '-J', '-t', pane.pane])).stdout).toContain('CREW_CONTEXT=');
  const status = JSON.parse((await cli(state, 'status', '--crew', 'sample', '--json')).stdout);
  expect(status.seats[0].status).toBe('launching');
}, 20000);

test('native startup failure is visible as failed and revokes the execution credential', async () => {
  const { directory, state, config, binary } = await fixture('exit');
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json').catch(() => {});
  await expect.poll(async () => {
    try {
      return JSON.parse((await cli(state, 'status', '--crew', 'sample', '--json')).stdout);
    } catch (error) {
      return JSON.parse((error as { stdout: string }).stdout);
    }
  }).toMatchObject({ seats: [{ status: 'failed', failure: expect.stringContaining('11') }] });
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const credential = await readFile(join(directory, 'native-credential'), 'utf8');
  expect((await fetch(`${discovery.url}/whoami`, { headers: { Authorization: `Bearer ${credential}` } })).status).toBe(401);
}, 20000);

test('HTTP rejects forged identity and malformed launch requests without creating a terminal', async () => {
  const { state } = await fixture();
  await cli(state, 'daemon', 'start');
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const forged = await fetch(`${discovery.url}/whoami`, { headers: {
    Authorization: 'Bearer invented-token', 'X-Crew-Seat': 'investigator', 'X-Crew-Execution': 'claimed-id',
  } });
  expect(forged.status).toBe(401);
  const denied = await fetch(`${discovery.url}/crews/up`, { method: 'POST', body: '{}' });
  expect(denied.status).toBe(401);
  const malformed = await fetch(`${discovery.url}/crews/up`, {
    method: 'POST', headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json' }, body: '{',
  });
  expect(malformed.status).toBe(400);
  const relative = await fetch(`${discovery.url}/crews/up`, { method: 'POST',
    headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ configPath: 'crew.yaml' }) });
  expect(relative.status).toBe(400);
  expect(await relative.json()).toMatchObject({ error: expect.stringContaining('absolute') });
  await expect(exec('tmux', ['-S', join(state, 'tmux.sock'), 'list-sessions'])).rejects.toThrow();
}, 20000);


test.each([
  ['role_file: role.md', 'role_file: missing.md', 'role_file'],
  ['role_file: role.md', 'role_file: role.md\n    cwd: missing', 'working directory'],
  ['runtime: claude', 'runtime: unsupported', 'configuration'],
])('invalid reference %s is rejected before terminal creation', async (original, replacement, message) => {
  const { state, config } = await fixture();
  await writeFile(config, (await readFile(config, 'utf8')).replace(original, replacement));
  await expect(cli(state, 'up', config)).rejects.toMatchObject({ stderr: expect.stringContaining(message) });
  await expect(exec('tmux', ['-S', join(state, 'tmux.sock'), 'list-sessions'])).rejects.toThrow();
}, 20000);

test('HTTP launch, status, and identity use scoped credentials and confirm native startup', async () => {
  const { directory, state, config, binary, project } = await fixture('hold');
  const working = join(project, 'work');
  await mkdir(working);
  await writeFile(config, (await readFile(config, 'utf8')) + '    cwd: project with spaces/work\n');
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const headers = { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json' };
  const response = await fetch(`${discovery.url}/crews/up`, { method: 'POST', headers, body: JSON.stringify({ configPath: config }) });
  expect(response.status).toBe(200);
  const launched = await response.json();
  expect(launched.seats[0].cwd).toBe(working);
  await expect.poll(async () => readFile(join(directory, 'native-credential'), 'utf8').catch(() => '')).not.toBe('');
  const credential = await readFile(join(directory, 'native-credential'), 'utf8');
  const agentHeaders = { ...headers, Authorization: `Bearer ${credential}`, 'X-Crew-Seat': 'invented' };
  expect((await fetch(`${discovery.url}/whoami`, { headers })).status).toBe(401);
  expect((await fetch(`${discovery.url}/crews/sample`, { headers: agentHeaders })).status).toBe(401);
  const identity = await fetch(`${discovery.url}/whoami`, { headers: agentHeaders });
  expect(await identity.json()).toMatchObject({ crew: 'sample', seat: 'investigator', crewId: expect.any(String), seatId: expect.any(String), executionId: launched.seats[0].executionId, status: 'launching' });
  const mismatch = await fetch(`${discovery.url}/executions/ready`, { method: 'POST', headers: agentHeaders,
    body: JSON.stringify({ sessionId: 'wrong', cwd: working }) });
  expect(mismatch.status).toBe(409);
  const accepted = await fetch(`${discovery.url}/executions/ready`, { method: 'POST', headers: agentHeaders,
    body: JSON.stringify({ sessionId: launched.seats[0].nativeSessionId, cwd: working }) });
  expect(accepted.status).toBe(200);
  const status = await fetch(`${discovery.url}/crews/sample`, { headers });
  expect(await status.json()).toMatchObject({ seats: [{ status: 'ready' }] });
  expect(JSON.stringify(launched)).not.toContain(credential);
}, 20000);

test.each([false, true])('failed launch cleans its terminal or reports bounded cleanup failure (%s)', async (stalledCleanup) => {
  const { directory, state, config, binary } = await fixture('hold');
  const tmux = (await exec('which', ['tmux'])).stdout.trim();
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'tmux'), `#!${process.execPath}
const { spawnSync } = await import('node:child_process');
const args = process.argv.slice(2);
if (${JSON.stringify(stalledCleanup)} && args.includes('kill-session')) {
  setTimeout(() => process.exit(1), 30000);
} else {
const result = spawnSync(${JSON.stringify(tmux)}, args, { stdio: 'inherit' });
process.exit(args.includes('new-session') && result.status === 0 ? 12 : result.status ?? 1);
}
`, { mode: 0o700 });
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary, PATH: `${bin}:${process.env.PATH}` }, timeout: 15000,
  });
  await expect(cli(state, 'up', config, '--json')).rejects.toMatchObject({ code: 1,
    stdout: expect.stringContaining('"status":"failed"') });
  if (stalledCleanup) {
    await expect(cli(state, 'status', '--crew', 'sample', '--json')).rejects.toMatchObject({
      stdout: expect.stringContaining('Terminal cleanup failed') });
    await cli(state, 'daemon', 'stop');
  } else {
    await expect(exec(tmux, ['-S', join(state, 'tmux.sock'), 'list-sessions'])).rejects.toThrow();
  }
}, 20000);

test.skipIf(process.env.CREW_NATIVE_SMOKE !== '1')('native Claude Code startup smoke check', async () => {
  const { state, config } = await fixture();
  const project = await realpath(process.env.CREW_NATIVE_PROJECT ?? process.cwd());
  await writeFile(config, `name: native-smoke\nproject: ${JSON.stringify(project)}\nagents:\n  investigator:\n    runtime: claude\n    role_file: role.md\n`);
  await cli(state, 'up', config, '--json');
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--crew', 'native-smoke', '--json')).stdout).seats[0].status,
    { timeout: 30000 }).toBe('ready');
}, 45000);


async function multiFixture(mode: 'normal' | 'discovery' = 'normal', seats = ['planner', 'coder', 'reviewer']) {
  const setup = await fixture(mode);
  for (const seat of seats) {
    await writeFile(join(setup.directory, `${seat}.md`), `You are the ${seat}. Perform only your assigned role.\n`);
  }
  await writeFile(setup.config, `name: sample\nproject: project with spaces\nagents:\n${seats.map((seat) => `  ${seat}:\n    runtime: claude\n    role_file: ${seat}.md\n`).join('')}`);
  return setup;
}

test('a complete crew launches distinct seats with their own roles and identities', async () => {
  const { state, config, binary } = await multiFixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  const launched = JSON.parse((await cli(state, 'up', config, '--json')).stdout);
  expect(launched.seats.map((seat: { name: string }) => seat.name)).toEqual(['planner', 'coder', 'reviewer']);
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--crew', 'sample', '--json')).stdout).status,
    { timeout: 10000 }).toBe('ready');
  const status = JSON.parse((await cli(state, 'status', '--crew', 'sample', '--json')).stdout);
  for (const field of ['seatId', 'executionId', 'generation', 'nativeSessionId']) {
    expect(new Set(status.seats.map((seat: Record<string, string>) => seat[field])).size).toBe(3);
    expect(status.seats.every((seat: Record<string, string>) => Boolean(seat[field]))).toBe(true);
  }
  expect(new Set(status.seats.map((seat: { tmux: { session: string } }) => seat.tmux.session)).size).toBe(3);
  for (const seat of status.seats) {
    await expect.poll(async () => (await exec('tmux', ['-S', seat.tmux.socket, 'capture-pane', '-p', '-J', '-S', '-', '-t', seat.tmux.pane])).stdout,
      { timeout: 10000 }).toContain('CREW_IDENTITY=');
    const output = (await exec('tmux', ['-S', seat.tmux.socket, 'capture-pane', '-p', '-J', '-S', '-', '-t', seat.tmux.pane])).stdout;
    expect(output).toContain(`You are the ${seat.name}`);
    expect(output).toContain(`"seat":"${seat.name}"`);
    expect(output).toContain(seat.executionId);
  }
}, 25000);


test('managed members and status stay in their crew while humans resolve ambiguous selection explicitly', async () => {
  const { directory, state, config, binary } = await multiFixture('discovery');
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json');
  const roster = JSON.parse((await cli(state, 'members', '--json')).stdout);
  expect(roster).toMatchObject({ crew: 'sample', members: [
    { seat: 'planner', role: 'You are the planner. Perform only your assigned role.\n' },
    { seat: 'coder', role: 'You are the coder. Perform only your assigned role.\n' },
    { seat: 'reviewer', role: 'You are the reviewer. Perform only your assigned role.\n' },
  ] });
  const status = JSON.parse((await cli(state, 'status', '--json')).stdout);
  for (const seat of status.seats) {
    await expect.poll(async () => (await exec('tmux', ['-S', seat.tmux.socket, 'capture-pane', '-p', '-J', '-S', '-', '-t', seat.tmux.pane])).stdout,
      { timeout: 10000 }).toContain('CREW_MEMBERS=');
    const context = await readFile(seat.contextFile, 'utf8');
    for (const teammate of ['planner', 'coder', 'reviewer']) expect(context).toContain(`You are the ${teammate}`);
    expect(context).toContain('crew members --json');
  }
  const credential = await readFile(join(directory, 'credential-planner'), 'utf8');
  const other = join(directory, 'other.yaml');
  await writeFile(other, (await readFile(config, 'utf8')).replace('name: sample', 'name: other'));
  await cli(state, 'up', other, '--json');
  await expect(cli(state, 'members', '--json')).rejects.toMatchObject({ stderr: expect.stringContaining('--crew') });
  await expect(cli(state, 'status', '--json')).rejects.toMatchObject({ stderr: expect.stringContaining('--crew') });
  expect(JSON.parse((await cli(state, 'members', '--crew', 'other', '--json')).stdout).crew).toBe('other');
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const agentHeaders = { Authorization: `Bearer ${credential}`, 'X-Crew': 'other' };
  const managed = await fetch(`${discovery.url}/members`, { headers: agentHeaders });
  expect(await managed.json()).toMatchObject({ crew: 'sample', members: [{ seat: 'planner' }, { seat: 'coder' }, { seat: 'reviewer' }] });
  expect((await fetch(`${discovery.url}/members?crew=other`, { headers: agentHeaders })).status).toBe(403);
  expect((await fetch(`${discovery.url}/crews?crew=other`, { headers: agentHeaders })).status).toBe(403);
  const scopedStatus = await fetch(`${discovery.url}/crews`, { headers: agentHeaders });
  expect(await scopedStatus.json()).toMatchObject({ name: 'sample' });
  const operatorHeaders = { Authorization: `Bearer ${discovery.token}` };
  expect((await fetch(`${discovery.url}/members`, { headers: operatorHeaders })).status).toBe(409);
  expect((await fetch(`${discovery.url}/members?crew=missing`, { headers: operatorHeaders })).status).toBe(404);
  expect((await fetch(`${discovery.url}/members?crew=sample`, { headers: { Authorization: 'Bearer invented' } })).status).toBe(401);
  const cliManaged = await exec(process.execPath, [cliPath, '--state-dir', state, 'members', '--json'], {
    env: { ...process.env, CREW_EXECUTION_TOKEN: credential, CREW_NAME: 'other', CREW_SEAT: 'invented' }, timeout: 15000,
  });
  expect(JSON.parse(cliManaged.stdout).crew).toBe('sample');
}, 30000);


test.each([
  ['role_file: reviewer.md', 'role_file: missing.md', 'role_file'],
  ['role_file: reviewer.md', 'role_file: reviewer.md\n    cwd: missing', 'working directory'],
  ['  reviewer:\n    runtime: claude', '  reviewer:\n    runtime: codex', 'configuration'],
  ['  reviewer:', '  planner:', 'unique'],
])('the entire crew is validated before any terminal is created (%s)', async (original, replacement, message) => {
  const { state, config } = await multiFixture();
  await writeFile(config, (await readFile(config, 'utf8')).replace(original, replacement));
  await cli(state, 'daemon', 'start');
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const headers = { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json' };
  const response = await fetch(`${discovery.url}/crews/up`, { method: 'POST', headers, body: JSON.stringify({ configPath: config }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining(message) });
  expect((await fetch(`${discovery.url}/crews/sample`, { headers })).status).toBe(404);
  await expect(exec('tmux', ['-S', join(state, 'tmux.sock'), 'list-sessions'])).rejects.toThrow();
}, 20000);

test('partial launch failure cleans the failed seat while keeping registered teammates ready', async () => {
  const { directory, state, config, binary } = await multiFixture();
  const tmux = (await exec('which', ['tmux'])).stdout.trim();
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'tmux'), `#!${process.execPath}
const { spawnSync } = await import('node:child_process');
const { readFileSync } = await import('node:fs');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(tmux)}, args, { stdio: 'inherit' });
const coder = args.includes('new-session') && JSON.parse(readFileSync(args.at(-1), 'utf8')).env.CREW_SEAT === 'coder';
process.exit(coder && result.status === 0 ? 12 : result.status ?? 1);
`, { mode: 0o700 });
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary, PATH: `${bin}:${process.env.PATH}` }, timeout: 15000,
  });
  await expect(cli(state, 'up', config, '--json')).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"status":"failed"') });
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const headers = { Authorization: `Bearer ${discovery.token}` };
  await expect.poll(async () => (await (await fetch(`${discovery.url}/crews/sample`, { headers })).json()).seats.map((seat: { status: string }) => seat.status))
    .toEqual(['ready', 'failed', 'ready']);
  const status = await (await fetch(`${discovery.url}/crews/sample`, { headers })).json();
  expect(status.status).toBe('failed');
  expect(status.seats[1]).toMatchObject({ name: 'coder', failure: expect.stringContaining('Launch failed'), tmux: null });
  const sessions = (await exec(tmux, ['-S', join(state, 'tmux.sock'), 'list-sessions', '-F', '#{session_name}'])).stdout.trim().split('\n');
  expect(sessions.sort()).toEqual([status.seats[0].tmux.session, status.seats[2].tmux.session].sort());
  const members = JSON.parse((await cli(state, 'members', '--crew', 'sample', '--json')).stdout);
  expect(members.members.map((seat: { status: string }) => seat.status)).toEqual(['ready', 'failed', 'ready']);
  await cli(state, 'daemon', 'stop');
}, 25000);

test('member roles preserve launch instructions even if the role source changes', async () => {
  const { directory, state, config, binary } = await multiFixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json');
  await writeFile(join(directory, 'planner.md'), 'Edited after launch.');
  const roster = JSON.parse((await cli(state, 'members', '--json')).stdout);
  expect(roster.members[0]).toMatchObject({ seat: 'planner', role: 'You are the planner. Perform only your assigned role.\n' });
}, 20000);


test('attach and detach select named seats without stopping agents or disconnecting other seats', async () => {
  const { directory, state, config, binary } = await multiFixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json');
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  const before = JSON.parse((await cli(state, 'status', '--json')).stdout);
  const socket = before.seats[0].tmux.socket;
  const outer = join(directory, 'outer.sock');
  try {
    for (const seat of ['planner', 'coder']) {
      await exec('tmux', ['-f', '/dev/null', '-S', outer, 'new-session', '-d', '-s', seat,
        '-x', '160', '-y', '40', process.execPath, cliPath, '--state-dir', state, 'attach', seat]);
    }
    await expect.poll(async () => (await exec('tmux', ['-S', socket, 'list-clients', '-F', '#{client_session}'])).stdout.trim().split('\n').sort())
      .toEqual([before.seats[0].tmux.session, before.seats[1].tmux.session].sort());
    const detached = await cli(state, 'detach', 'planner');
    expect(detached.stdout).toContain('planner');
    expect((await exec('tmux', ['-S', socket, 'list-clients', '-F', '#{client_session}'])).stdout.trim()).toBe(before.seats[1].tmux.session);
    await cli(state, 'detach', 'coder');
    expect((await exec('tmux', ['-S', socket, 'list-clients'])).stdout.trim()).toBe('');
    const after = JSON.parse((await cli(state, 'status', '--json')).stdout);
    expect(after.seats.map((seat: { executionId: string; status: string }) => ({ id: seat.executionId, status: seat.status })))
      .toEqual(before.seats.map((seat: { executionId: string }) => ({ id: seat.executionId, status: 'ready' })));
  } finally {
    await exec('tmux', ['-S', outer, 'kill-server'], { timeout: 5000 }).catch(() => {});
  }
}, 25000);


test('terminal commands report unknown seats, require interactive attachment, and demand explicit crew selection when ambiguous', async () => {
  const { directory, state, config, binary } = await fixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json');
  await expect(cli(state, 'detach', 'missing')).rejects.toMatchObject({ stderr: expect.stringContaining('Available seats: investigator') });
  await expect(cli(state, 'attach', 'investigator')).rejects.toMatchObject({ stderr: expect.stringContaining('interactive terminal') });
  const other = join(directory, 'other.yaml');
  await writeFile(other, (await readFile(config, 'utf8')).replace('name: sample', 'name: other'));
  await cli(state, 'up', other, '--json');
  await expect(cli(state, 'detach', 'investigator')).rejects.toMatchObject({ stderr: expect.stringContaining('--crew') });
  await cli(state, 'detach', 'investigator', '--crew', 'sample');
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--crew', 'other', '--json')).stdout).status).toBe('ready');
  const credential = await readFile(join(directory, 'credential-investigator'), 'utf8');
  await expect(exec(process.execPath, [cliPath, '--state-dir', state, 'detach', 'investigator', '--crew', 'sample'], {
    env: { ...process.env, CREW_EXECUTION_TOKEN: credential }, timeout: 15000,
  })).rejects.toMatchObject({ stderr: expect.stringContaining('only inspect their own crew') });
}, 20000);


test.each([
  { count: 3, seats: ['planner', 'coder', 'reviewer'] },
  { count: 6, seats: ['planner', 'coder', 'reviewer', 'auditor', 'designer', 'tester'] },
])('a tiled crew view shows all seats and closes without replacing or stopping agents ($count seats)', async ({ seats }) => {
  const { directory, state, config, binary } = await multiFixture('normal', seats);
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json');
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  const before = JSON.parse((await cli(state, 'status', '--json')).stdout);
  const views = join(state, 'views.sock');
  const outer = join(directory, 'outer.sock');
  try {
    await exec('tmux', ['-f', '/dev/null', '-S', outer, 'new-session', '-d', '-s', 'viewer', '-x', '160', '-y', '40',
      'sleep', '60']);
    await exec('tmux', ['-S', outer, 'set-window-option', '-t', 'viewer:0', 'remain-on-exit', 'on']);
    await exec('tmux', ['-S', outer, 'respawn-pane', '-k', '-t', 'viewer:0', process.execPath, cliPath, '--state-dir', state, 'attach', '--crew', 'sample']);
    await expect.poll(async () => {
      try { return (await exec('tmux', ['-S', views, 'list-panes', '-a', '-F', '#{@crew_seat}'])).stdout.trim().split('\n'); }
      catch { return []; }
    }, { timeout: 3000 }).toEqual(seats);
    await expect.poll(async () => (await exec('tmux', ['-S', before.seats[0].tmux.socket, 'list-clients', '-F', '#{client_session}'])).stdout.trim().split('\n').sort())
      .toEqual(before.seats.map((seat: { tmux: { session: string } }) => seat.tmux.session).sort());
    await expect.poll(async () => (await exec('tmux', ['-S', views, 'list-clients'])).stdout.trim()).not.toBe('');
    await exec('tmux', ['-S', outer, 'send-keys', '-t', 'viewer:0', 'C-a', 'd']);
    await expect.poll(async () => (await exec('tmux', ['-S', before.seats[0].tmux.socket, 'list-clients'])).stdout.trim()).toBe('');
    await exec('tmux', ['-S', outer, 'respawn-pane', '-k', '-t', 'viewer:0', process.execPath, cliPath, '--state-dir', state, 'attach', '--crew', 'sample']);
    await expect.poll(async () => {
      try { return (await exec('tmux', ['-S', views, 'list-panes', '-a', '-F', '#{@crew_seat}'])).stdout.trim().split('\n'); }
      catch { return []; }
    }, { timeout: 5000 }).toEqual(seats);
    await cli(state, 'detach', '--crew', 'sample');
    await expect.poll(async () => (await exec('tmux', ['-S', before.seats[0].tmux.socket, 'list-clients'])).stdout.trim()).toBe('');
    const after = JSON.parse((await cli(state, 'status', '--json')).stdout);
    expect(after.seats.map((seat: { executionId: string; status: string }) => ({ id: seat.executionId, status: seat.status })))
      .toEqual(before.seats.map((seat: { executionId: string }) => ({ id: seat.executionId, status: 'ready' })));
  } catch (error) {
    console.error((await exec('tmux', ['-S', outer, 'capture-pane', '-p', '-J', '-S', '-'])).stdout);
    throw error;
  } finally {
    await exec('tmux', ['-S', outer, 'kill-server'], { timeout: 5000 }).catch(() => {});
    await exec('tmux', ['-S', views, 'kill-server'], { timeout: 5000 }).catch(() => {});
  }
}, 25000);


test('matching startup reuses executions and changed configuration cannot replace them', async () => {
  const { directory, state, config, binary } = await multiFixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json');
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  const before = JSON.parse((await cli(state, 'status', '--json')).stdout);
  const reused = JSON.parse((await cli(state, 'up', config, '--json')).stdout);
  expect(reused.seats.map((seat: { executionId: string }) => seat.executionId)).toEqual(before.seats.map((seat: { executionId: string }) => seat.executionId));
  const concurrent = await Promise.all([cli(state, 'up', config, '--json'), cli(state, 'up', config, '--json')]);
  for (const result of concurrent) expect(JSON.parse(result.stdout).seats.map((seat: { executionId: string }) => seat.executionId)).toEqual(before.seats.map((seat: { executionId: string }) => seat.executionId));
  expect((await exec('tmux', ['-S', before.seats[0].tmux.socket, 'list-sessions'])).stdout.trim().split('\n')).toHaveLength(3);
  await writeFile(join(directory, 'planner.md'), 'Changed planner instructions.');
  await expect(cli(state, 'up', config)).rejects.toMatchObject({ stderr: expect.stringContaining('configuration') });
  const after = JSON.parse((await cli(state, 'status', '--json')).stdout);
  expect(after.seats.map((seat: { executionId: string }) => seat.executionId)).toEqual(before.seats.map((seat: { executionId: string }) => seat.executionId));
}, 25000);


test('crew shutdown retains history, preserves other crews, and relaunch revokes old identities', async () => {
  const { directory, state, config, binary } = await fixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json');
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--crew', 'sample', '--json')).stdout).status).toBe('ready');
  const before = JSON.parse((await cli(state, 'status', '--crew', 'sample', '--json')).stdout);
  const credential = await readFile(join(directory, 'native-credential'), 'utf8');
  const other = join(directory, 'other.yaml');
  await writeFile(other, (await readFile(config, 'utf8')).replace('name: sample', 'name: other'));
  await cli(state, 'up', other, '--json');
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--crew', 'other', '--json')).stdout).status).toBe('ready');
  const stopped = JSON.parse((await cli(state, 'down', '--crew', 'sample', '--json')).stdout);
  expect(stopped.status).toBe('stopped');
  expect(stopped.seats[0].history).toMatchObject([{ executionId: before.seats[0].executionId, status: 'stopped' }]);
  await expect(cli(state, 'attach', 'investigator', '--crew', 'sample')).rejects.toMatchObject({ stderr: expect.stringContaining('no active terminal (stopped)') });
  expect(JSON.parse((await cli(state, 'status', '--crew', 'other', '--json')).stdout).status).toBe('ready');
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  expect((await fetch(`${discovery.url}/whoami`, { headers: { Authorization: `Bearer ${credential}` } })).status).toBe(401);
  await cli(state, 'up', config, '--json');
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--crew', 'sample', '--json')).stdout).status).toBe('ready');
  const after = JSON.parse((await cli(state, 'status', '--crew', 'sample', '--json')).stdout);
  expect(after.id).toBe(before.id);
  expect(after.seats[0].seatId).toBe(before.seats[0].seatId);
  expect(after.seats[0].executionId).not.toBe(before.seats[0].executionId);
  expect(after.seats[0].generation).not.toBe(before.seats[0].generation);
  expect(after.seats[0].history).toHaveLength(2);
  expect((await fetch(`${discovery.url}/whoami`, { headers: { Authorization: `Bearer ${credential}` } })).status).toBe(401);
}, 25000);

test('shutdown reports stopping until the managed terminal actually exits', async () => {
  const { directory, state, config, binary } = await fixture();
  const tmux = (await exec('which', ['tmux'])).stdout.trim();
  const bin = join(directory, 'bin');
  const marker = join(directory, 'shutdown-started');
  const release = join(directory, 'shutdown-release');
  await mkdir(bin);
  await writeFile(join(bin, 'tmux'), `#!${process.execPath}
const { spawnSync } = await import('node:child_process');
const { writeFileSync, existsSync } = await import('node:fs');
const args = process.argv.slice(2);
if (args.includes('kill-session')) {
  writeFileSync(${JSON.stringify(marker)}, 'stopping');
  const deadline = Date.now() + 1500;
  while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
process.exit(spawnSync(${JSON.stringify(tmux)}, args, { stdio: 'inherit' }).status ?? 1);
`, { mode: 0o700 });
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary, PATH: `${bin}:${process.env.PATH}` }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json');
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const headers = { Authorization: `Bearer ${discovery.token}` };
  const shutdown = fetch(`${discovery.url}/crews/down`, { method: 'POST', headers, body: JSON.stringify({ crew: 'sample' }) });
  try {
    await expect.poll(() => readFile(marker, 'utf8').catch(() => null)).toBe('stopping');
    const during = await (await fetch(`${discovery.url}/crews/sample`, { headers })).json();
    expect(during.status).toBe('stopping');
    expect(during.seats[0].status).toBe('stopping');
    await exec('tmux', ['-S', during.seats[0].tmux.socket, 'has-session', '-t', during.seats[0].tmux.session]);
  } finally {
    await writeFile(release, 'release');
    expect(await (await shutdown).json()).toMatchObject({ status: 'stopped' });
  }
}, 25000);

test.each(['shutdown', 'startup'])('failed process inspection cannot mark a surviving native process stopped (%s)', async (failurePhase) => {
  const { directory, state, config, binary } = await fixture();
  const pidFile = join(directory, 'native-pid');
  const marker = join(directory, 'terminal-stopping');
  await writeFile(binary, (await readFile(binary, 'utf8')).replace('const args = process.argv.slice(2);', `
process.on('SIGHUP', () => {});
setInterval(() => {}, 1000);
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const args = process.argv.slice(2);`));
  const tmux = (await exec('which', ['tmux'])).stdout.trim();
  const ps = (await exec('which', ['ps'])).stdout.trim();
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'tmux'), `#!${process.execPath}
const { spawnSync } = await import('node:child_process');
const { writeFileSync } = await import('node:fs');
const args = process.argv.slice(2);
if (args.includes('kill-session')) writeFileSync(${JSON.stringify(marker)}, 'stopping');
process.exit(spawnSync(${JSON.stringify(tmux)}, args, { stdio: 'inherit' }).status ?? 1);
`, { mode: 0o700 });
  await writeFile(join(bin, 'ps'), `#!${process.execPath}
const { spawnSync } = await import('node:child_process');
const { existsSync, readFileSync } = await import('node:fs');
const args = process.argv.slice(2);
const fail = ${JSON.stringify(failurePhase)} === 'shutdown' ? existsSync(${JSON.stringify(marker)}) : !existsSync(${JSON.stringify(marker)});
if (fail && existsSync(${JSON.stringify(pidFile)}) && args[args.indexOf('-p') + 1] === readFileSync(${JSON.stringify(pidFile)}, 'utf8')) process.exit(1);
process.exit(spawnSync(${JSON.stringify(ps)}, args, { stdio: 'inherit' }).status ?? 1);
`, { mode: 0o700 });
  let pid: number | undefined;
  try {
    await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
      env: { ...process.env, CREW_CLAUDE_BIN: binary, PATH: `${bin}:${process.env.PATH}` }, timeout: 15000,
    });
    const launched = JSON.parse((await cli(state, 'up', config, '--json')).stdout);
    await expect.poll(async () => (await exec('tmux', ['-S', launched.seats[0].tmux.socket, 'capture-pane', '-p', '-J', '-S', '-', '-t', launched.seats[0].tmux.pane])).stdout).toContain('CREW_IDENTITY=');
    if (failurePhase === 'shutdown') await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
    else await expect(cli(state, 'status', '--json')).rejects.toMatchObject({ stdout: expect.stringContaining('"status":"unknown"') });
    await expect.poll(() => readFile(pidFile, 'utf8').catch(() => '')).not.toBe('');
    pid = Number(await readFile(pidFile, 'utf8'));
    await expect(cli(state, 'down', '--crew', 'sample')).rejects.toMatchObject({ code: 1 });
    expect(() => process.kill(pid!, 0)).not.toThrow();
    await expect(cli(state, 'status', '--json')).rejects.toMatchObject({ stdout: expect.stringContaining('"status":"unknown"') });
    await expect(cli(state, 'up', config)).rejects.toMatchObject({ stderr: expect.stringContaining('unexplained') });
  } finally {
    pid ??= Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    if (pid > 0) process.kill(pid, 'SIGKILL');
  }
}, 25000);

test('HTTP shutdown authorization and daemon restart preserve verified execution identities', async () => {
  const { directory, state, config, binary } = await fixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json');
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  const before = JSON.parse((await cli(state, 'status', '--json')).stdout);
  const credential = await readFile(join(directory, 'native-credential'), 'utf8');
  let discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const denied = await fetch(`${discovery.url}/crews/down`, { method: 'POST', headers: { Authorization: `Bearer ${credential}` }, body: JSON.stringify({ crew: 'sample' }) });
  expect(denied.status).toBe(401);
  await cli(state, 'daemon', 'stop');
  expect((await exec('tmux', ['-S', before.seats[0].tmux.socket, 'list-sessions', '-F', '#{session_name}'])).stdout).toContain(before.seats[0].tmux.session);
  await cli(state, 'daemon', 'start');
  discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const after = await (await fetch(`${discovery.url}/crews/sample`, { headers: { Authorization: `Bearer ${discovery.token}` } })).json();
  expect(after.seats[0]).toMatchObject({ status: 'ready', executionId: before.seats[0].executionId, generation: before.seats[0].generation });
  expect((await fetch(`${discovery.url}/whoami`, { headers: { Authorization: `Bearer ${credential}` } })).status).toBe(200);
  const stopped = await fetch(`${discovery.url}/crews/down`, { method: 'POST', headers: { Authorization: `Bearer ${discovery.token}` }, body: JSON.stringify({ crew: 'sample' }) });
  expect(await stopped.json()).toMatchObject({ status: 'stopped' });
}, 25000);

test('a missing or mismatched terminal is reported and never silently replaced', async () => {
  const { state, config, binary } = await fixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json');
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  const before = JSON.parse((await cli(state, 'status', '--json')).stdout);
  const terminal = before.seats[0].tmux;
  await cli(state, 'daemon', 'stop');
  await exec('tmux', ['-S', terminal.socket, 'kill-session', '-t', terminal.session]);
  await exec('tmux', ['-f', '/dev/null', '-S', terminal.socket, 'new-session', '-d', '-s', terminal.session, 'sleep', '60']);
  await cli(state, 'daemon', 'start');
  await expect(cli(state, 'status', '--json')).rejects.toMatchObject({ stdout: expect.stringContaining('"status":"unknown"') });
  await expect(cli(state, 'up', config)).rejects.toMatchObject({ stderr: expect.stringContaining('unexplained') });
  await expect(cli(state, 'down', '--crew', 'sample')).rejects.toMatchObject({ stderr: expect.stringContaining('unverified') });
  await expect(cli(state, 'attach', 'investigator')).rejects.toMatchObject({ stderr: expect.stringContaining('no active terminal (unknown)') });
  await expect(cli(state, 'detach', 'investigator')).rejects.toMatchObject({ stderr: expect.stringContaining('no active terminal (unknown)') });
  expect((await exec('tmux', ['-S', terminal.socket, 'list-sessions', '-F', '#{session_name}'])).stdout.trim()).toBe(terminal.session);
}, 25000);


test('repeated startup completes a known launch failure without replacing healthy seats', async () => {
  const { directory, state, config, binary } = await multiFixture();
  const tmux = (await exec('which', ['tmux'])).stdout.trim();
  const bin = join(directory, 'bin');
  const marker = join(directory, 'fail-once');
  await mkdir(bin);
  await writeFile(marker, 'fail');
  await writeFile(join(bin, 'tmux'), `#!${process.execPath}
const { spawnSync } = await import('node:child_process');
const { readFileSync, existsSync, unlinkSync } = await import('node:fs');
const args = process.argv.slice(2);
const coder = args.includes('new-session') && JSON.parse(readFileSync(args.at(-1), 'utf8')).env.CREW_SEAT === 'coder';
if (coder && existsSync(${JSON.stringify(marker)})) { unlinkSync(${JSON.stringify(marker)}); process.exit(12); }
process.exit(spawnSync(${JSON.stringify(tmux)}, args, { stdio: 'inherit' }).status ?? 1);
`, { mode: 0o700 });
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary, PATH: `${bin}:${process.env.PATH}` }, timeout: 15000,
  });
  await expect(cli(state, 'up', config, '--json')).rejects.toMatchObject({ code: 1 });
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const headers = { Authorization: `Bearer ${discovery.token}` };
  const before = await (await fetch(`${discovery.url}/crews/sample`, { headers })).json();
  const retried = await fetch(`${discovery.url}/crews/up`, { method: 'POST', headers,
    body: JSON.stringify({ configPath: config }) });
  expect(retried.status, JSON.stringify(await retried.json())).toBe(200);
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  const after = JSON.parse((await cli(state, 'status', '--json')).stdout);
  expect(after.seats[0].executionId).toBe(before.seats[0].executionId);
  expect(after.seats[2].executionId).toBe(before.seats[2].executionId);
  expect(after.seats[1].executionId).not.toBe(before.seats[1].executionId);
  expect(after.seats[1].seatId).toBe(before.seats[1].seatId);
  expect(after.seats[1].history).toHaveLength(2);
}, 25000);


test('missing executions require an explicit crew shutdown before a fresh launch', async () => {
  const { state, config, binary } = await fixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json');
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  const before = JSON.parse((await cli(state, 'status', '--json')).stdout);
  await cli(state, 'daemon', 'stop');
  await exec('tmux', ['-S', before.seats[0].tmux.socket, 'kill-session', '-t', before.seats[0].tmux.session]);
  await cli(state, 'daemon', 'start');
  await expect(cli(state, 'status', '--json')).rejects.toMatchObject({ stdout: expect.stringContaining('"status":"unknown"') });
  await expect(cli(state, 'up', config)).rejects.toMatchObject({ stderr: expect.stringContaining('unexplained') });
  await cli(state, 'down', '--crew', 'sample');
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'stop']);
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  const launched = JSON.parse((await cli(state, 'up', config, '--json')).stdout);
  expect(launched.seats[0].executionId).not.toBe(before.seats[0].executionId);
}, 25000);
