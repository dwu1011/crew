import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';

const exec = promisify(execFile);
const cliPath = resolve('dist/cli.js');
const fixtures: { directory: string; state: string }[] = [];

async function fixture(mode: 'normal' | 'hold' | 'exit' = 'normal') {
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
if (${JSON.stringify(mode)} === 'exit') process.exit(11);
if (${JSON.stringify(mode)} === 'hold') { process.stdin.resume(); } else {
const hook = settings.hooks.SessionStart[0].hooks[0].command;
const result = spawnSync('/bin/sh', ['-c', hook], { input: JSON.stringify({ session_id: option('--session-id'), cwd: process.cwd() }), encoding: 'utf8' });
if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
const identity = spawnSync('crew', ['whoami', '--json'], { encoding: 'utf8' });
console.log('CREW_IDENTITY=' + identity.stdout.trim());
if (identity.status !== 0) { console.error(identity.stderr); process.exit(1); }
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
