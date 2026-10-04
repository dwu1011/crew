import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { connect } from 'node:net';
import { afterEach, expect, test } from 'vitest';

const exec = promisify(execFile);
const cliPath = resolve('dist/cli.js');
const fixtures: { directory: string; state: string }[] = [];

async function fixture(mode: 'normal' | 'hold' | 'exit' | 'discovery' | 'delivery' | 'delivery-slow' = 'normal') {
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
if (process.argv.includes('--version')) { console.log(${JSON.stringify(mode)}.startsWith('delivery') ? '2.1.289 (Claude Code fixture)' : '2.1.283 (Claude Code fixture)'); process.exit(0); }
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
if (${JSON.stringify(mode)}.startsWith('delivery')) {
  const render = (visible = '', footer = '-- INSERT -- ⏵⏵ auto mode on') => { writeFileSync(${JSON.stringify(join(directory, 'current-draft.txt'))}, draft); process.stdout.write('\\x1b[2J\\x1b[HClaude Code v2.1.289\\n────────────────────────────────────────\\n❯ ' + visible.replaceAll('\\n', '\\n  ') + '\\n────────────────────────────────────────\\n  Model: Opus 5.5 | Thinking: medium\\n  Context: [░░░░]\\n  ' + footer + '\\x1b[3;3H\\x1b[?2004h'); };
  process.stdin.setRawMode(true);
  let draft = '', pasting = false, paste = '', collapsed = false, received = [];
  render();
  process.stdin.on('data', chunk => {
    let text = chunk.toString();
    if (text.includes('\\x1b[200~')) { pasting = true; paste = ''; text = text.replace('\\x1b[200~', ''); }
    const endPaste = text.includes('\\x1b[201~');
    text = text.replace('\\x1b[201~', '');
    if (text === '\\x15') { draft = ''; collapsed = false; render(); return; }
    if (text === '\\x10') { process.stdout.write('\\x1b[2J\\x1b[HDo you want to proceed?\\n❯ 1. Allow once\\nEsc to cancel'); return; }
    if (text === '\\x13') { process.stdout.write('\\x1b[2J\\x1b[HChoose option\\n❯ 1. Allow once\\nEsc to cancel'); return; }
    if (text === '\\x02') { render('', 'esc to interrupt'); return; }
    if (text === '\\x12') { process.stdout.write('\\x1b[2J\\x1b[HUnrecognized native screen'); return; }
    if (!pasting && text.includes('\\r')) {
      received.push(draft + text.replaceAll('\\r', ''));
      writeFileSync(${JSON.stringify(join(directory, 'received.json'))}, JSON.stringify(received));
      draft = ''; render(); return;
    }
    if (pasting) paste += text; else draft += text;
    if (endPaste) {
      pasting = false;
      if (${JSON.stringify(mode)} === 'delivery-slow' && collapsed) {
        if (paste !== draft) draft += paste;
        collapsed = false; render(draft); return;
      }
      draft += paste;
      if (${JSON.stringify(mode)} === 'delivery-slow') {
        collapsed = true;
        process.stdout.write('\\x1b[2J\\x1b[HRendering paste...');
        setTimeout(() => { if (collapsed) render('[Pasted text #1 +6 lines]', 'paste again to expand'); }, 650);
        return;
      }
    }
    if (${JSON.stringify(mode)} === 'delivery-slow') {
      process.stdout.write('\\x1b[2J\\x1b[HRendering input...');
      setTimeout(() => { if (!collapsed) render(draft); }, 650);
      return;
    }
    render(draft);
  });
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

async function deliveryFault(phase: 'load' | 'paste' | 'target' | 'enter' | 'draft' | 'collapsed' | 'crash-before-paste' | 'crash-after-paste' | 'crash-after-enter' | 'ack-race') {
  const item = await fixture(phase === 'collapsed' ? 'delivery-slow' : 'delivery');
  const tmux = (await exec('which', ['tmux'])).stdout.trim();
  const bin = join(item.directory, 'fault-bin');
  const marker = join(item.directory, 'input-attempt');
  const release = join(item.directory, 'release-input');
  await mkdir(bin);
  await writeFile(join(bin, 'tmux'), `#!${process.execPath}
const { spawnSync } = await import('node:child_process');
const { writeFileSync, existsSync } = await import('node:fs');
const args = process.argv.slice(2), phase = ${JSON.stringify(phase)};
const run = (argv) => spawnSync(${JSON.stringify(tmux)}, argv, { stdio: 'inherit' });
const replace = (socket) => {
  const session = spawnSync(${JSON.stringify(tmux)}, ['-S', socket, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).stdout.trim();
  run(['-S', socket, 'kill-session', '-t', '=' + session]);
  run(['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', session, 'sleep', '60']);
};
if (phase.startsWith('crash-') && args.includes('if-shell') && !existsSync(${JSON.stringify(marker)})) {
  const paste = args.some(arg => arg.includes('paste-buffer'));
  const enter = args.some(arg => arg.includes('send-keys'));
  if ((phase !== 'crash-after-enter' && paste) || (phase === 'crash-after-enter' && enter)) {
    if (phase !== 'crash-before-paste') run(args);
    writeFileSync(${JSON.stringify(marker)}, phase);
    process.kill(process.ppid, 'SIGKILL');
    process.exit(15);
  }
}
if (phase === 'ack-race' && args.includes('load-buffer')) {
  writeFileSync(${JSON.stringify(marker)}, 'prepared');
  const deadline = Date.now() + 1500;
  while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
if (phase === 'load' && args.includes('load-buffer')) process.exit(13);
if (phase === 'paste' && args.includes('if-shell') && args.some(arg => arg.includes('paste-buffer'))) {
  writeFileSync(${JSON.stringify(marker)}, 'submitting');
  const deadline = Date.now() + 1500;
  while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  run(args); process.exit(14);
}
if (phase === 'enter' && args.includes('if-shell') && args.some(arg => arg.includes('send-keys'))) replace(args[args.indexOf('-S') + 1]);
const result = run(args);
if (phase === 'collapsed' && args.includes('if-shell') && args.some(arg => arg.includes('paste-buffer')) && !existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, 'replaced');
  const socket = args[args.indexOf('-S') + 1], pane = args[args.indexOf('-t') + 1];
  run(['-S', socket, 'send-keys', '-t', pane, 'C-u']);
  writeFileSync(${JSON.stringify(join(item.directory, 'foreign.txt'))}, 'HUMAN_REPLACEMENT\\nsecond line\\nthird line\\nfourth line');
  run(['-S', socket, 'load-buffer', '-b', 'foreign', ${JSON.stringify(join(item.directory, 'foreign.txt'))}]);
  run(['-S', socket, 'paste-buffer', '-t', pane, '-b', 'foreign', '-r', '-p']);
}

if (phase === 'draft' && args.includes('if-shell') && args.some(arg => arg.includes('paste-buffer')))
  run(['-S', args[args.indexOf('-S') + 1], 'send-keys', '-t', args[args.indexOf('-t') + 1], '-l', 'USER_EXTRA']);
if (phase === 'target' && args.includes('load-buffer')) {
  const socket = args[args.indexOf('-S') + 1];
  replace(socket);
  writeFileSync(${JSON.stringify(marker)}, 'replaced');
}
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  await exec(process.execPath, [cliPath, '--state-dir', item.state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: item.binary, PATH: `${bin}:${process.env.PATH}` }, timeout: 15000,
  });
  return { ...item, marker, release };
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
  const managed = JSON.parse((await cli(state, 'status', '--json')).stdout).seats[0].tmux;
  await expect.poll(async () => (await exec('tmux', ['-S', managed.socket, 'capture-pane', '-p', '-J', '-t', managed.pane])).stdout).toContain('CREW_IDENTITY=');
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
    const response = await shutdown;
    expect(await response.json(), response.ok ? undefined : await readFile(join(state, 'daemon.log'), 'utf8')).toMatchObject({ status: 'stopped' });
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


test('an operator can persist and inspect a pending message to a stopped seat', async () => {
  const { state, config, binary } = await fixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config, '--json');
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  await cli(state, 'down', '--crew', 'sample');
  const sent = JSON.parse((await cli(state, 'send', 'investigator', '--text', 'Inspect the parser.', '--request-id', 'operator-request', '--json')).stdout);
  expect(sent).toMatchObject({ requestId: 'operator-request', body: 'Inspect the parser.', sender: { kind: 'operator', seat: null, executionId: null },
    recipient: { seat: 'investigator' }, acknowledgedAt: null, deliveries: [{ status: 'pending', executionId: null }] });
  expect(sent.id).toBeTruthy();
  const shown = JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout);
  expect(shown).toEqual({ ...sent, deliveries: [expect.objectContaining({ id: sent.deliveries[0].id, status: 'pending' })] });
  expect(JSON.parse((await cli(state, 'inbox', '--json')).stdout).messages).toEqual([{ ...sent, deliveries: [expect.objectContaining({ id: sent.deliveries[0].id, status: 'pending' })] }]);
}, 20000);

test('submission retries recover the original message across restart and reject conflicting reuse', async () => {
  const { state, config, binary } = await fixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config);
  let discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const submit = () => fetch(`${discovery.url}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${discovery.token}` },
    body: JSON.stringify({ recipient: 'investigator', body: 'Recover this request.', requestId: 'lost-response' }) });
  const first = await submit();
  expect(first.status).toBe(200);
  await first.body!.cancel();
  const recovered = await (await submit()).json();
  expect(recovered).toMatchObject({ body: 'Recover this request.', deliveries: [{ status: 'pending' }] });
  const stable = { ...recovered, deliveries: [expect.objectContaining({ id: recovered.deliveries[0].id, status: 'pending', executionId: null })] };
  const concurrent = await Promise.all([submit(), submit()]);
  for (const response of concurrent) expect(await response.json()).toEqual(stable);
  await cli(state, 'daemon', 'stop');
  await cli(state, 'daemon', 'start');
  discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  expect(await (await submit()).json()).toEqual(stable);
  const conflict = await fetch(`${discovery.url}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${discovery.token}` },
    body: JSON.stringify({ recipient: 'investigator', body: 'Changed contents.', requestId: 'lost-response' }) });
  expect(conflict.status).toBe(409);
  expect(JSON.parse((await cli(state, 'inbox', '--all', '--json')).stdout).messages).toEqual([stable]);
  expect(JSON.parse((await cli(state, 'message', 'show', recovered.id, '--json')).stdout).acknowledgedAt).toBeNull();
}, 20000);

test('managed messages derive their sender and enforce crew and participant scope', async () => {
  const { directory, state, config, binary } = await multiFixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config);
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  const crew = JSON.parse((await cli(state, 'status', '--json')).stdout);
  const plannerToken = await readFile(join(directory, 'credential-planner'), 'utf8');
  const coderToken = await readFile(join(directory, 'credential-coder'), 'utf8');
  const reviewerToken = await readFile(join(directory, 'credential-reviewer'), 'utf8');
  const sent = JSON.parse((await exec(process.execPath, [cliPath, '--state-dir', state, 'send', 'coder', '--text', 'unique-persisted-only-request', '--request-id', 'agent-request', '--json'],
    { env: { ...process.env, CREW_EXECUTION_TOKEN: plannerToken } })).stdout);
  expect(sent.sender).toEqual({ kind: 'agent', seat: 'planner', seatId: crew.seats[0].seatId, executionId: crew.seats[0].executionId });
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const send = (credential: string, extra = {}) => fetch(`${discovery.url}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${credential}` },
    body: JSON.stringify({ recipient: 'coder', body: 'A request.', requestId: 'other-request', ...extra }) });
  expect((await send(plannerToken, { senderSeat: 'reviewer' })).status).toBe(400);
  expect((await send(plannerToken, { crew: 'other' })).status).toBe(403);
  expect((await send('invalid')).status).toBe(401);
  expect((await send(discovery.token, { recipient: 'missing' })).status).toBe(404);
  const coderHeaders = { Authorization: `Bearer ${coderToken}` };
  expect(await (await fetch(`${discovery.url}/inbox`, { headers: coderHeaders })).json()).toMatchObject({ messages: [sent] });
  expect(await (await fetch(`${discovery.url}/inbox?all=true`, { headers: coderHeaders })).json()).toMatchObject({ messages: [sent] });
  expect((await fetch(`${discovery.url}/messages/${sent.id}`, { headers: { Authorization: `Bearer ${reviewerToken}` } })).status).toBe(404);
  expect(await (await fetch(`${discovery.url}/messages/${sent.id}`, { headers: coderHeaders })).json()).toEqual({ ...sent, deliveries: [expect.objectContaining({ id: sent.deliveries[0].id, status: 'pending' })] });
  expect((await exec('tmux', ['-S', crew.seats[1].tmux.socket, 'capture-pane', '-p', '-J', '-S', '-', '-t', crew.seats[1].tmux.pane])).stdout).not.toContain('unique-persisted-only-request');
  await cli(state, 'down', '--crew', 'sample');
  expect((await send(plannerToken)).status).toBe(401);
}, 20000);

test('CLI preserves literal file and stdin bodies and reports a recoverable request identity', async () => {
  const { directory, state, config, binary } = await fixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config);
  const sentinel = join(directory, 'must-not-exist');
  const body = `Unicode: café 雪\nQuotes: ' "\nBackticks: \`touch ${sentinel}\`\nShell: $(touch ${sentinel})\n`;
  const file = join(directory, 'message.txt');
  await writeFile(file, body);
  const fileResult = await cli(state, 'send', 'investigator', '--body-file', file, '--json');
  const sent = JSON.parse(fileResult.stdout);
  expect(sent.body).toBe(body);
  expect(fileResult.stderr).toContain(sent.requestId);
  const stdinResult = await new Promise<string>((resolveOutput, reject) => {
    const child = execFile(process.execPath, [cliPath, '--state-dir', state, 'send', 'investigator', '--body-file', '-', '--json'],
      (error, stdout) => error ? reject(error) : resolveOutput(stdout));
    const bytes = Buffer.from(body);
    const split = bytes.indexOf(Buffer.from('雪')) + 1;
    child.stdin!.write(bytes.subarray(0, split));
    child.stdin!.end(bytes.subarray(split));
  });
  expect(JSON.parse(stdinResult).body).toBe(body);
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(cli(state, 'send', 'investigator', '--json')).rejects.toMatchObject({ stderr: expect.stringContaining('exactly one') });
  await expect(cli(state, 'send', 'investigator', '--text', 'one', '--body-file', file)).rejects.toMatchObject({ stderr: expect.stringContaining('exactly one') });
  expect(JSON.parse((await cli(state, 'inbox', '--json')).stdout).messages).toHaveLength(2);
}, 20000);

test('operator messaging requires unambiguous crew selection and validates the HTTP contract', async () => {
  const { directory, state, config, binary } = await fixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config);
  const other = join(directory, 'other.yaml');
  await writeFile(other, (await readFile(config, 'utf8')).replace('name: sample', 'name: other'));
  await cli(state, 'up', other);
  await expect(cli(state, 'send', 'investigator', '--text', 'Unselected.')).rejects.toMatchObject({ stderr: expect.stringContaining('Multiple crews') });
  const sent = JSON.parse((await cli(state, 'send', 'investigator', '--crew', 'sample', '--text', 'Selected.', '--request-id', 'selected-request', '--json')).stdout);
  await expect(cli(state, 'message', 'show', sent.id, '--crew', 'other')).rejects.toMatchObject({ stderr: expect.stringContaining('not found') });
  expect(JSON.parse((await cli(state, 'inbox', '--crew', 'other', '--all', '--json')).stdout).messages).toEqual([]);
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  for (const body of [null, { crew: 'sample', recipient: 'investigator', body: 'Missing request ID.' },
    { crew: 'sample', recipient: 'investigator', body: 12, requestId: 'invalid-body' }]) {
    const response = await fetch(`${discovery.url}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${discovery.token}` }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
  }
  expect(JSON.parse((await cli(state, 'inbox', '--crew', 'sample', '--json')).stdout).messages).toEqual([{ ...sent, deliveries: [expect.objectContaining({ id: sent.deliveries[0].id, status: 'pending' })] }]);
}, 20000);

test.each(['delivery', 'delivery-slow'] as const)('a full literal message is submitted to the verified ready terminal without acknowledgment (%s)', async (mode) => {
  const { directory, state, config, binary } = await fixture(mode);
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config);
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  const seat = JSON.parse((await cli(state, 'status', '--json')).stdout).seats[0];
  const body = "Line one: café 雪\nLine two: 'quotes' \"double\" `echo literal` $(echo literal)\nDo you want to proceed? esc to interrupt\n";
  const sent = JSON.parse((await cli(state, 'send', 'investigator', '--text', body, '--json')).stdout);
  expect(sent.deliveries[0].status).toBe('pending');
  await expect.poll(async () => JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[0],
    { timeout: 12000 }).toMatchObject({ status: 'submitted' });
  const observed = JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout);
  expect(observed).toMatchObject({ acknowledgedAt: null, deliveries: [{ executionId: seat.executionId, generation: seat.generation, pane: seat.tmux.pane, status: 'submitted' }] });
  await expect.poll(() => readFile(join(directory, 'received.json'), 'utf8').catch(() => ''), { timeout: 5000 }).not.toBe('');
  const received = JSON.parse(await readFile(join(directory, 'received.json'), 'utf8'));
  expect(received).toHaveLength(1);
  expect(received[0]).toContain(sent.id);
  expect(received[0]).toContain('Sender: operator');
  expect(received[0]).toContain('Recipient: investigator');
  expect(received[0]).toContain(body);
  expect(received[0]).toContain('Reply guidance:');
}, 20000);

test.each([
  ['existing draft', 'My existing draft', 'draft'],
  ['permission dialog', '\u0010', 'Unrecognized'],
  ['selection menu', '\u0013', 'Unrecognized'],
  ['busy turn', '\u0002', 'busy'],
  ['unknown screen', '\u0012', 'Unrecognized'],
])('delivery defers for %s and resumes after a verified empty prompt', async (_name, input, reason) => {
  const { directory, state, config, binary } = await fixture('delivery');
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config);
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  const seat = JSON.parse((await cli(state, 'status', '--json')).stdout).seats[0];
  await exec('tmux', ['-S', seat.tmux.socket, 'send-keys', '-t', seat.tmux.pane, '-l', input]);
  const sent = JSON.parse((await cli(state, 'send', 'investigator', '--text', 'Wait until input is safe.', '--json')).stdout);
  await expect.poll(async () => JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[0], { timeout: 8000 })
    .toMatchObject({ status: 'pending', failure: expect.stringContaining(reason) });
  await expect(readFile(join(directory, 'received.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  if (input === 'My existing draft') expect((await exec('tmux', ['-S', seat.tmux.socket, 'capture-pane', '-p', '-t', seat.tmux.pane])).stdout).toContain(input);
  await exec('tmux', ['-S', seat.tmux.socket, 'send-keys', '-t', seat.tmux.pane, 'C-u']);
  await expect.poll(async () => JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[0].status, { timeout: 8000 }).toBe('submitted');
  const received = JSON.parse(await readFile(join(directory, 'received.json'), 'utf8'));
  expect(received).toHaveLength(1);
  expect(received[0]).toContain(sent.id);
}, 20000);

test('messages to one seat are submitted as distinct serialized envelopes', async () => {
  const { directory, state, config, binary } = await fixture('delivery');
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: binary }, timeout: 15000,
  });
  await cli(state, 'up', config);
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const messages = await Promise.all(['First body.\n雪', 'Second body.\nCafé'].map(async (body, index) => {
    const response = await fetch(`${discovery.url}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${discovery.token}` },
      body: JSON.stringify({ recipient: 'investigator', body, requestId: `serialized-${index}` }) });
    expect(response.status).toBe(200);
    return response.json();
  }));
  await expect.poll(async () => JSON.parse(await readFile(join(directory, 'received.json'), 'utf8').catch(() => '[]')).length,
    { timeout: 10000 }).toBe(2);
  const received = JSON.parse(await readFile(join(directory, 'received.json'), 'utf8'));
  for (const message of messages) {
    const envelope = received.find((text: string) => text.includes(message.id));
    expect(envelope).toContain(message.body);
    expect(envelope).not.toContain(messages.find((other) => other.id !== message.id).id);
    expect(JSON.parse((await cli(state, 'message', 'show', message.id, '--json')).stdout).deliveries).toHaveLength(1);
  }
}, 20000);

test('failure before terminal input is definite and is not automatically retried', async () => {
  const { directory, state, config } = await deliveryFault('load');
  await cli(state, 'up', config);
  const sent = JSON.parse((await cli(state, 'send', 'investigator', '--text', 'Do not retry a definite failure.', '--request-id', 'failed-input', '--json')).stdout);
  await expect.poll(async () => JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[0].status,
    { timeout: 8000 }).toBe('failed');
  await cli(state, 'send', 'investigator', '--text', 'Do not retry a definite failure.', '--request-id', 'failed-input');
  const shown = JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout);
  expect(shown.deliveries).toHaveLength(1);
  expect(shown.deliveries[0].status).toBe('failed');
  await expect(readFile(join(directory, 'received.json'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 20000);

test('submitting precedes paste and an ambiguous paste failure stays uncertain', async () => {
  const { directory, state, config, marker, release } = await deliveryFault('paste');
  await cli(state, 'up', config);
  const sent = JSON.parse((await cli(state, 'send', 'investigator', '--text', 'Paste uncertainty.', '--request-id', 'uncertain-input', '--json')).stdout);
  try {
    await expect.poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 8000 }).toBe('submitting');
    expect(JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[0].status).toBe('submitting');
  } finally { await writeFile(release, 'release'); }
  await expect.poll(async () => JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[0].status,
    { timeout: 8000 }).toBe('uncertain');
  const seat = JSON.parse((await cli(state, 'status', '--json')).stdout).seats[0];
  expect((await exec('tmux', ['-S', seat.tmux.socket, 'capture-pane', '-p', '-J', '-t', seat.tmux.pane])).stdout).toContain(sent.id);
  await exec('tmux', ['-S', seat.tmux.socket, 'send-keys', '-t', seat.tmux.pane, 'C-u']);
  await cli(state, 'send', 'investigator', '--text', 'Paste uncertainty.', '--request-id', 'uncertain-input');
  expect(JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries).toMatchObject([{ status: 'uncertain' }]);
  await expect(readFile(join(directory, 'received.json'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 20000);

test('a terminal replaced after preparation receives no stale message input', async () => {
  const { state, config, marker } = await deliveryFault('target');
  await cli(state, 'up', config);
  const sent = JSON.parse((await cli(state, 'send', 'investigator', '--text', 'Never write to a replacement terminal.', '--json')).stdout);
  await expect.poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 8000 }).toBe('replaced');
  await expect.poll(async () => JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[0],
    { timeout: 8000 }).toMatchObject({ status: 'pending', executionId: null, failure: expect.any(String) });
  const socket = join(state, 'tmux.sock');
  expect((await exec('tmux', ['-S', socket, 'capture-pane', '-p', '-t', '%0'])).stdout).not.toContain(sent.id);
  expect((await exec('tmux', ['-S', socket, 'list-panes', '-a', '-F', '#{pane_current_command}'])).stdout.trim()).toBe('sleep');
}, 20000);

test.each(['enter', 'draft', 'collapsed'] as const)('delivery refuses Enter after a post-paste %s change', async (phase) => {
  const { directory, state, config } = await deliveryFault(phase);
  await cli(state, 'up', config);
  const sent = JSON.parse((await cli(state, 'send', 'investigator', '--text', 'Verify again before Enter.', '--json')).stdout);
  await expect.poll(async () => JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[0].status,
    { timeout: 8000 }).toBe('uncertain');
  await expect(readFile(join(directory, 'received.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const capture = (await exec('tmux', ['-S', join(state, 'tmux.sock'), 'capture-pane', '-p', '-J', '-t', '%0'])).stdout;
  if (phase === 'enter') expect(capture).not.toContain(sent.id);
  else expect(capture).toContain(phase === 'collapsed' ? '[Pasted text #1' : 'USER_EXTRA');
  if (phase === 'collapsed') expect(await readFile(join(directory, 'current-draft.txt'), 'utf8')).toBe('HUMAN_REPLACEMENT\nsecond line\nthird line\nfourth line');
}, 20000);

test('unsupported terminal versions remain pending and unsafe control bytes are never injected', async () => {
  const unsupported = await fixture();
  await exec(process.execPath, [cliPath, '--state-dir', unsupported.state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: unsupported.binary }, timeout: 15000,
  });
  await cli(unsupported.state, 'up', unsupported.config);
  const held = JSON.parse((await cli(unsupported.state, 'send', 'investigator', '--text', 'Unsupported input profile.', '--json')).stdout);
  await expect.poll(async () => JSON.parse((await cli(unsupported.state, 'message', 'show', held.id, '--json')).stdout).deliveries[0], { timeout: 8000 })
    .toMatchObject({ status: 'pending', failure: expect.stringContaining('Unsupported') });
  const supported = await fixture('delivery');
  await exec(process.execPath, [cliPath, '--state-dir', supported.state, 'daemon', 'start'], {
    env: { ...process.env, CREW_CLAUDE_BIN: supported.binary }, timeout: 15000,
  });
  await cli(supported.state, 'up', supported.config);
  const file = join(supported.directory, 'unsafe-body.txt');
  await writeFile(file, 'Literal escape: \u001b[201~');
  const failed = JSON.parse((await cli(supported.state, 'send', 'investigator', '--body-file', file, '--json')).stdout);
  await expect.poll(async () => JSON.parse((await cli(supported.state, 'message', 'show', failed.id, '--json')).stdout).deliveries[0], { timeout: 8000 })
    .toMatchObject({ status: 'failed', failure: expect.stringContaining('control characters'), submittingAt: null });
  await expect(readFile(join(supported.directory, 'received.json'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 20000);

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

test('only the current recipient can acknowledge, and inspection does not create receipt', async () => {
  const { directory, state, config, binary } = await multiFixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], { env: { ...process.env, CREW_CLAUDE_BIN: binary } });
  await cli(state, 'up', config);
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  const coder = await readFile(join(directory, 'credential-coder'), 'utf8');
  const reviewer = await readFile(join(directory, 'credential-reviewer'), 'utf8');
  const sent = JSON.parse((await cli(state, 'send', 'coder', '--text', 'Please inspect.', '--json')).stdout);
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const ack = (token: string, extra = {}) => fetch(`${discovery.url}/messages/${sent.id}/ack`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(extra) });
  expect(JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).acknowledgedAt).toBeNull();
  expect((await ack(reviewer)).status).toBe(404);
  expect((await ack(discovery.token)).status).toBe(403);
  expect((await ack(coder, { crew: 'other' })).status).toBe(403);
  const received = JSON.parse((await exec(process.execPath, [cliPath, '--state-dir', state, 'ack', sent.id, '--json'], { env: { ...process.env, CREW_EXECUTION_TOKEN: coder } })).stdout);
  expect(received.acknowledgment).toMatchObject({ executionId: expect.any(String), acknowledgedAt: expect.any(String) });
  expect((await (await ack(coder)).json()).acknowledgment).toEqual(received.acknowledgment);
  expect((await (await fetch(`${discovery.url}/inbox`, { headers: { Authorization: `Bearer ${coder}` } })).json()).messages).toHaveLength(0);
  expect((await (await fetch(`${discovery.url}/inbox?all=true`, { headers: { Authorization: `Bearer ${coder}` } })).json()).messages).toHaveLength(1);
  await cli(state, 'down', '--crew', 'sample');
  expect((await ack(coder)).status).toBe(401);
}, 25000);

test('linked replies atomically acknowledge their original and preserve request identity and operator routing', async () => {
  const { directory, state, config, binary } = await multiFixture();
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], { env: { ...process.env, CREW_CLAUDE_BIN: binary } });
  await cli(state, 'up', config);
  await expect.poll(async () => JSON.parse((await cli(state, 'status', '--json')).stdout).status).toBe('ready');
  const coder = await readFile(join(directory, 'credential-coder'), 'utf8');
  const planner = await readFile(join(directory, 'credential-planner'), 'utf8');
  const reviewer = await readFile(join(directory, 'credential-reviewer'), 'utf8');
  const managed = (token: string, ...args: string[]) => exec(process.execPath, [cliPath, '--state-dir', state, ...args], { env: { ...process.env, CREW_EXECUTION_TOKEN: token } });
  const original = JSON.parse((await managed(planner, 'send', 'coder', '--text', 'Inspect.', '--json')).stdout);
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const reply = (token: string, id: string, body: string, requestId = 'reply-1') => fetch(`${discovery.url}/messages/${id}/reply`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ body, requestId }) });
  expect((await reply(reviewer, original.id, 'No.')).status).toBe(404);
  expect((await reply(planner, original.id, 'No.')).status).toBe(403);
  expect(JSON.parse((await cli(state, 'message', 'show', original.id, '--json')).stdout).acknowledgedAt).toBeNull();
  const body = "Findings: café 雪\n'quotes' `echo literal` $(echo literal)\n";
  const file = join(directory, 'reply.txt');
  await writeFile(file, body);
  const created = JSON.parse((await managed(coder, 'reply', original.id, '--body-file', file, '--request-id', 'reply-1', '--json')).stdout);
  expect(created).toMatchObject({ body, replyTo: original.id, sender: { seat: 'coder' }, recipient: { kind: 'agent', seat: 'planner' }, deliveries: [{ status: 'pending' }] });
  expect(created.id).not.toBe(original.id);
  const shown = JSON.parse((await cli(state, 'message', 'show', original.id, '--json')).stdout);
  expect(shown).toMatchObject({ acknowledgment: { executionId: expect.any(String) }, replies: [{ id: created.id }] });
  expect((await (await reply(coder, original.id, body)).json()).id).toBe(created.id);
  expect((await reply(coder, original.id, 'Changed.')).status).toBe(409);
  await expect(managed(coder, 'send', 'planner', '--text', body, '--request-id', 'reply-1')).rejects.toMatchObject({ stderr: expect.stringContaining('different content') });
  const operatorMessage = JSON.parse((await cli(state, 'send', 'coder', '--text', 'Report to operator.', '--json')).stdout);
  expect((await reply(coder, operatorMessage.id, body)).status).toBe(409);
  expect(JSON.parse((await cli(state, 'message', 'show', operatorMessage.id, '--json')).stdout).acknowledgedAt).toBeNull();
  const humanReply = await (await reply(coder, operatorMessage.id, 'Operator findings.', 'reply-human')).json();
  expect(humanReply).toMatchObject({ recipient: { kind: 'operator', seat: null, seatId: null }, replyTo: operatorMessage.id, deliveries: [] });
  expect(JSON.parse((await cli(state, 'inbox', '--json')).stdout).messages.map((m: { id: string }) => m.id)).toContain(humanReply.id);
  await expect(managed(coder, 'reply', original.id)).rejects.toMatchObject({ stderr: expect.stringContaining('exactly one') });
  await expect(managed(coder, 'reply', original.id, '--text', 'x', '--body-file', file)).rejects.toMatchObject({ stderr: expect.stringContaining('exactly one') });
  await cli(state, 'daemon', 'stop');
  await cli(state, 'daemon', 'start');
  expect(JSON.parse((await cli(state, 'message', 'show', original.id, '--json')).stdout).acknowledgment).toEqual(shown.acknowledgment);
  expect(JSON.parse((await cli(state, 'message', 'show', humanReply.id, '--json')).stdout)).toEqual(humanReply);
}, 30000);

test('persisted pending delivery survives stopped recipients and restart, then targets the new generation once', async () => {
  const { directory, state, config, binary } = await fixture('delivery');
  const start = () => exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], { env: { ...process.env, CREW_CLAUDE_BIN: binary } });
  await start();
  await cli(state, 'up', config);
  await expect.poll(() => readFile(join(directory, 'current-draft.txt'), 'utf8').catch(() => null)).toBe('');
  const before = JSON.parse((await cli(state, 'status', '--json')).stdout).seats[0];
  await cli(state, 'down', '--crew', 'sample');
  const sent = JSON.parse((await cli(state, 'send', 'investigator', '--text', 'Stopped recipient recovery.', '--json')).stdout);
  await cli(state, 'daemon', 'stop');
  await start();
  expect(JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[0].status).toBe('pending');
  await cli(state, 'up', config);
  await expect.poll(async () => JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[0].status, { timeout: 8000 }).toBe('submitted');
  const after = JSON.parse((await cli(state, 'status', '--json')).stdout).seats[0];
  expect(after.seatId).toBe(before.seatId);
  expect(after.executionId).not.toBe(before.executionId);
  expect(after.generation).not.toBe(before.generation);
  const shown = JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout);
  expect(shown.deliveries).toMatchObject([{ executionId: after.executionId, generation: after.generation, status: 'submitted' }]);
  expect(shown.deliveries).toHaveLength(1);
  await cli(state, 'daemon', 'stop');
  await start();
  expect(JSON.parse((await cli(state, 'status', '--json')).stdout).seats[0].executionId).toBe(after.executionId);
  await new Promise((resolve) => setTimeout(resolve, 650));
  const received = JSON.parse(await readFile(join(directory, 'received.json'), 'utf8'));
  expect(received).toHaveLength(1);
  expect(received[0]).toContain(sent.id);
  expect(JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries).toEqual(shown.deliveries);
}, 30000);

test('startup reconciles before delivery and HTTP pending work resumes on the same surviving execution', async () => {
  const { directory, state, config, binary } = await fixture('delivery');
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], { env: { ...process.env, CREW_CLAUDE_BIN: binary } });
  await cli(state, 'up', config);
  await expect.poll(() => readFile(join(directory, 'current-draft.txt'), 'utf8').catch(() => null)).toBe('');
  const before = JSON.parse((await cli(state, 'status', '--json')).stdout).seats[0];
  await exec('tmux', ['-S', before.tmux.socket, 'send-keys', '-t', before.tmux.pane, '-l', 'USER_DRAFT']);
  let discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const sent = await (await fetch(`${discovery.url}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${discovery.token}` }, body: JSON.stringify({ recipient: 'investigator', body: 'HTTP restart recovery.', requestId: 'http-recover' }) })).json();
  await cli(state, 'daemon', 'stop');
  const tmux = (await exec('which', ['tmux'])).stdout.trim(), bin = join(directory, 'reconcile-bin');
  const marker = join(directory, 'reconciling'), release = join(directory, 'reconcile-release');
  await mkdir(bin);
  await writeFile(join(bin, 'tmux'), `#!${process.execPath}
const { spawnSync } = await import('node:child_process');
const { existsSync, writeFileSync } = await import('node:fs');
const args = process.argv.slice(2);
if (args.includes('has-session') && !existsSync(${JSON.stringify(release)})) {
  writeFileSync(${JSON.stringify(marker)}, 'reconciling');
  const deadline = Date.now() + 1500;
  while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
process.exit(spawnSync(${JSON.stringify(tmux)}, args, { stdio: 'inherit' }).status ?? 1);
`, { mode: 0o700 });
  const restarting = exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], { env: { ...process.env, CREW_CLAUDE_BIN: binary, PATH: `${bin}:${process.env.PATH}` } });
  try {
    await expect.poll(() => readFile(marker, 'utf8').catch(() => '')).toBe('reconciling');
    expect(await readFile(join(directory, 'current-draft.txt'), 'utf8')).toBe('USER_DRAFT');
    await expect(readFile(join(directory, 'received.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await writeFile(release, 'release'); await restarting; }
  discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const show = async () => (await fetch(`${discovery.url}/messages/${sent.id}`, { headers: { Authorization: `Bearer ${discovery.token}` } })).json();
  expect((await show()).deliveries[0].status).toBe('pending');
  const after = JSON.parse((await cli(state, 'status', '--json')).stdout).seats[0];
  expect(after.executionId).toBe(before.executionId);
  expect(after.generation).toBe(before.generation);
  expect(after.nativeSessionId).toBe(before.nativeSessionId);
  await exec('tmux', ['-S', before.tmux.socket, 'send-keys', '-t', before.tmux.pane, 'C-u']);
  await expect.poll(async () => (await show()).deliveries[0], { timeout: 8000 }).toMatchObject({ status: 'submitted', executionId: before.executionId, generation: before.generation });
  expect(JSON.parse(await readFile(join(directory, 'received.json'), 'utf8'))).toHaveLength(1);
}, 30000);

test('explicit definite-failure retry preserves history, rejects active or acknowledged messages, and enforces scope', async () => {
  const { directory, state, config } = await deliveryFault('load');
  await cli(state, 'up', config);
  const sent = JSON.parse((await cli(state, 'send', 'investigator', '--text', 'Retry this definite failure.', '--json')).stdout);
  await expect.poll(async () => JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[0].status, { timeout: 8000 }).toBe('failed');
  const failed = JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout);
  expect(JSON.parse((await cli(state, 'status', '--json')).stdout).deliveryIssues.map((m: { id: string }) => m.id)).toContain(sent.id);
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const retry = (body: unknown, token = discovery.token) => fetch(`${discovery.url}/messages/${sent.id}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  expect((await retry({ allowDuplicate: 'yes' })).status).toBe(400);
  expect((await retry({}, 'invalid')).status).toBe(401);
  expect((await retry({ crew: 'missing' })).status).toBe(404);
  const credential = await readFile(join(directory, 'native-credential'), 'utf8');
  expect((await retry({ crew: 'other' }, credential)).status).toBe(403);
  const seat = JSON.parse((await cli(state, 'status', '--json')).stdout).seats[0];
  await exec('tmux', ['-S', seat.tmux.socket, 'send-keys', '-t', seat.tmux.pane, '-l', 'HOLD_RETRY']);
  const retried = JSON.parse((await cli(state, 'message', 'retry', sent.id, '--json')).stdout);
  expect(retried.id).toBe(sent.id);
  expect(retried.deliveries).toHaveLength(2);
  expect(retried.deliveries[0]).toEqual(failed.deliveries[0]);
  expect(retried.deliveries[1]).toMatchObject({ status: 'pending', executionId: null });
  const concurrent = await Promise.all([retry({}), retry({ allowDuplicate: true })]);
  expect(concurrent.map((r) => r.status)).toEqual([409, 409]);
  await exec(process.execPath, [cliPath, '--state-dir', state, 'ack', sent.id, '--json'], { env: { ...process.env, CREW_EXECUTION_TOKEN: credential } });
  await exec('tmux', ['-S', seat.tmux.socket, 'send-keys', '-t', seat.tmux.pane, 'C-u']);
  await new Promise((resolve) => setTimeout(resolve, 650));
  expect(JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[1].status).toBe('pending');
  await expect(cli(state, 'message', 'retry', sent.id, '--allow-duplicate')).rejects.toMatchObject({ stderr: expect.stringMatching(/acknowledged/i) });
  expect(JSON.parse((await cli(state, 'status', '--json')).stdout).deliveryIssues).toHaveLength(0);
  await expect(readFile(join(directory, 'received.json'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 25000);

test.each(['crash-before-paste', 'crash-after-paste', 'crash-after-enter'] as const)('isolated %s becomes uncertain without blind resend and requires explicit duplicate acceptance', async (phase) => {
  const { directory, state, config, marker } = await deliveryFault(phase);
  await cli(state, 'up', config);
  await expect.poll(() => readFile(join(directory, 'current-draft.txt'), 'utf8').catch(() => null)).toBe('');
  const discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const sent = JSON.parse((await cli(state, 'send', 'investigator', '--text', 'Preserve crash message.', '--json')).stdout);
  await expect.poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 8000 }).toBe(phase);
  await expect.poll(() => { try { process.kill(discovery.pid, 0); return true; } catch { return false; } }).toBe(false);
  await cli(state, 'daemon', 'start');
  const shown = JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout);
  expect(shown.body).toBe('Preserve crash message.');
  expect(shown.deliveries).toMatchObject([{ status: 'uncertain', submittingAt: expect.any(String), failure: expect.stringContaining('restarted') }]);
  expect(shown.deliveries).toHaveLength(1);
  expect(JSON.parse((await cli(state, 'status', '--json')).stdout).deliveryIssues).toMatchObject([{ id: sent.id, deliveries: [{ status: 'uncertain' }] }]);
  await new Promise((resolve) => setTimeout(resolve, 650));
  if (phase === 'crash-after-enter') await expect.poll(async () => JSON.parse(await readFile(join(directory, 'received.json'), 'utf8')).length).toBe(1);
  else await expect(readFile(join(directory, 'received.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(cli(state, 'message', 'retry', sent.id)).rejects.toMatchObject({ stderr: expect.stringContaining('--allow-duplicate') });
  const current = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const refused = await fetch(`${current.url}/messages/${sent.id}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${current.token}` }, body: '{}' });
  expect(refused.status).toBe(409);
  const seat = JSON.parse((await cli(state, 'status', '--json')).stdout).seats[0];
  await exec('tmux', ['-S', seat.tmux.socket, 'send-keys', '-t', seat.tmux.pane, 'C-u']);
  const retry = await fetch(`${current.url}/messages/${sent.id}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${current.token}` }, body: JSON.stringify({ allowDuplicate: true }) });
  expect(retry.status).toBe(200);
  const retried = await retry.json();
  expect(retried.id).toBe(sent.id);
  expect(retried.deliveries).toHaveLength(2);
  expect(retried.deliveries[0]).toEqual(shown.deliveries[0]);
  await expect.poll(async () => JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[1].status, { timeout: 8000 }).toBe('submitted');
  await expect.poll(async () => JSON.parse(await readFile(join(directory, 'received.json'), 'utf8')).length).toBe(phase === 'crash-after-enter' ? 2 : 1);
  const records = JSON.parse(await readFile(join(directory, 'received.json'), 'utf8'));
  expect(records.every((body: string) => body.includes(sent.id))).toBe(true);
  const credential = await readFile(join(directory, 'native-credential'), 'utf8');
  await exec(process.execPath, [cliPath, '--state-dir', state, 'ack', sent.id, '--json'], { env: { ...process.env, CREW_EXECUTION_TOKEN: credential } });
  await expect(cli(state, 'message', 'retry', sent.id, '--allow-duplicate')).rejects.toMatchObject({ stderr: expect.stringMatching(/acknowledged/i) });
}, 30000);

test.each(['before-commit', 'after-commit-before-input'] as const)('isolated %s crash preserves the acceptance boundary and recovers a single pending message', async (phase) => {
  const { directory, state, config, binary } = await fixture('delivery');
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], { env: { ...process.env, CREW_CLAUDE_BIN: binary } });
  await cli(state, 'up', config);
  await expect.poll(() => readFile(join(directory, 'current-draft.txt'), 'utf8').catch(() => null)).toBe('');
  const seat = JSON.parse((await cli(state, 'status', '--json')).stdout).seats[0];
  await exec('tmux', ['-S', seat.tmux.socket, 'send-keys', '-t', seat.tmux.pane, '-l', 'HOLD_CRASH']);
  let discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const body = { recipient: 'investigator', body: 'Acceptance boundary.', requestId: 'crash-request' };
  let original: { id: string } | undefined;
  const socket = connect(Number(new URL(discovery.url).port), '127.0.0.1');
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  try {
    if (phase === 'before-commit') {
      const payload = JSON.stringify(body);
      socket.write(`POST /messages HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${discovery.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload.slice(0, -1)}`);
      expect((await fetch(`${discovery.url}/health`)).status).toBe(200);
    } else {
      original = await (await fetch(`${discovery.url}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${discovery.token}` }, body: JSON.stringify(body) })).json();
    }
    process.kill(discovery.pid, 'SIGKILL');
    await expect.poll(() => { try { process.kill(discovery.pid, 0); return true; } catch { return false; } }).toBe(false);
  } finally { socket.destroy(); }
  await cli(state, 'daemon', 'start');
  discovery = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8'));
  const inbox = JSON.parse((await cli(state, 'inbox', '--all', '--json')).stdout).messages;
  expect(inbox).toHaveLength(original ? 1 : 0);
  const recovered = await (await fetch(`${discovery.url}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${discovery.token}` }, body: JSON.stringify(body) })).json();
  if (original) expect(recovered.id).toBe(original.id);
  expect(recovered.deliveries).toHaveLength(1);
  expect(recovered.deliveries[0].status).toBe('pending');
  expect(JSON.parse((await cli(state, 'status', '--json')).stdout).seats[0].executionId).toBe(seat.executionId);
  await exec('tmux', ['-S', seat.tmux.socket, 'send-keys', '-t', seat.tmux.pane, 'C-u']);
  await expect.poll(async () => JSON.parse((await cli(state, 'message', 'show', recovered.id, '--json')).stdout).deliveries[0].status, { timeout: 8000 }).toBe('submitted');
  await expect(cli(state, 'message', 'retry', recovered.id, '--allow-duplicate')).rejects.toMatchObject({ stderr: expect.stringContaining('Only a definite failure') });
  expect(JSON.parse(await readFile(join(directory, 'received.json'), 'utf8'))).toHaveLength(1);
}, 25000);

test.skipIf(process.env.CREW_NATIVE_MVP_SMOKE !== '1')('native crew messaging and recovery smoke', async () => {
  const { directory, state, project, config } = await multiFixture();
  await writeFile(join(project, 'math.ts'), 'export const add = (a: number, b: number) => a - b;\n');
  const common = 'Read-only validation. Never edit project files. Use crew CLI for coordination. Keep each message body line under 80 characters. Do not send more messages than the requested smoke flow.\n';
  await writeFile(join(directory, 'planner.md'), common + 'When the operator requests validation, send coder one request to inspect math.ts and reply via crew reply. When coder replies, acknowledge that reply and send one linked reply to the original operator request with your findings. Then stop.\n');
  await writeFile(join(directory, 'coder.md'), common + 'When planner requests inspection, read math.ts, reply to that message with findings, then send reviewer one request to review math.ts and reply via crew reply. Acknowledge reviewer reply and then stop.\n');
  await writeFile(join(directory, 'reviewer.md'), common + 'When coder requests review, read math.ts and send one linked reply to that request with findings. Then stop.\n');
  await exec(process.execPath, [cliPath, '--state-dir', state, 'daemon', 'start'], { env: { ...process.env, CREW_CLAUDE_BIN: process.env.CREW_NATIVE_BIN ?? 'claude' } });
  await cli(state, 'up', config);
  let crew = JSON.parse((await cli(state, 'status', '--json')).stdout);
  for (const seat of crew.seats) {
    await exec('tmux', ['-S', seat.tmux.socket, 'resize-window', '-t', seat.tmux.session, '-x', '240', '-y', '80']);
  }
  await expect.poll(async () => {
    const status = JSON.parse((await cli(state, 'status', '--json')).stdout);
    for (const seat of status.seats) {
      if (seat.status !== 'launching') continue;
      const screen = (await exec('tmux', ['-S', seat.tmux.socket, 'capture-pane', '-p', '-t', seat.tmux.pane])).stdout;
      if (screen.includes(project) && /Quick safety check|Do you trust/.test(screen)) {
        if (/❯\s*No, exit/.test(screen) && /Yes, I trust this folder/.test(screen))
          await exec('tmux', ['-S', seat.tmux.socket, 'send-keys', '-t', seat.tmux.pane, 'Down', 'Enter']);
        else if (/❯\s*1\.\s*Yes/.test(screen))
          await exec('tmux', ['-S', seat.tmux.socket, 'send-keys', '-t', seat.tmux.pane, 'Enter']);
      }
    }
    return status.status;
  }, { timeout: 45000, interval: 500 }).toBe('ready');
  crew = JSON.parse((await cli(state, 'status', '--json')).stdout);
  expect(crew.seats.every((seat: { nativeVersion: string }) => seat.nativeVersion === '2.1.289')).toBe(true);
  for (const seat of crew.seats) {
    await exec('tmux', ['-S', seat.tmux.socket, 'send-keys', '-t', seat.tmux.pane, '-l', 'Only reply READY and wait. Do not perform the smoke flow yet. No tools or edits.']);
    await exec('tmux', ['-S', seat.tmux.socket, 'send-keys', '-t', seat.tmux.pane, 'Enter']);
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const request = JSON.parse((await cli(state, 'send', 'planner', '--text', 'Run the read-only smoke flow now. Ask coder to inspect math.ts.\nHave coder reply and request reviewer review.\nHave reviewer reply to coder; report back to this operator request.', '--request-id', 'native-mvp-request', '--json')).stdout);
  let conversation: any[] = [];
  await expect.poll(async () => {
    conversation = JSON.parse((await cli(state, 'inbox', '--all', '--json')).stdout).messages;
    for (const seat of crew.seats) {
      const pending = conversation.some((message) => message.recipient.seat === seat.name && message.deliveries.some((attempt: { status: string }) => attempt.status === 'pending') && !message.acknowledgedAt);
      if (!pending) continue;
      const screen = (await exec('tmux', ['-S', seat.tmux.socket, 'capture-pane', '-p', '-t', seat.tmux.pane])).stdout;
      const tail = screen.split('\n').filter((line: string) => line.trim()).slice(-12).join('\n');
      if (/-- INSERT --/.test(tail) && !/esc to interrupt|[✳✻✽✶].*…/.test(tail) && /^❯.+$/m.test(tail))
        await exec('tmux', ['-S', seat.tmux.socket, 'send-keys', '-t', seat.tmux.pane, 'C-u']);
    }
    const coderReply = conversation.find((m) => m.sender.seat === 'coder' && m.recipient.seat === 'planner' && m.replyTo);
    const reviewRequest = conversation.find((m) => m.sender.seat === 'coder' && m.recipient.seat === 'reviewer');
    const reviewReply = conversation.find((m) => m.sender.seat === 'reviewer' && m.replyTo === reviewRequest?.id);
    const operatorReply = conversation.find((m) => m.sender.seat === 'planner' && m.replyTo === request.id && m.recipient.kind === 'operator');
    return !!(coderReply && reviewRequest && reviewReply && operatorReply);
  }, { timeout: 180000, interval: 1000 }).toBe(true);
  const before = JSON.parse((await cli(state, 'status', '--json')).stdout);
  const history = conversation.map((m) => ({ id: m.id, body: m.body, replyTo: m.replyTo, acknowledgedAt: m.acknowledgedAt }));
  await cli(state, 'daemon', 'stop');
  await cli(state, 'daemon', 'start');
  const after = JSON.parse((await cli(state, 'status', '--json')).stdout);
  expect(after.seats.map((seat: any) => [seat.seatId, seat.executionId, seat.generation, seat.nativeSessionId])).toEqual(before.seats.map((seat: any) => [seat.seatId, seat.executionId, seat.generation, seat.nativeSessionId]));
  const persisted = JSON.parse((await cli(state, 'inbox', '--all', '--json')).stdout).messages;
  for (const message of history) expect(persisted.find((m: any) => m.id === message.id)).toMatchObject(message);
  const unread = JSON.parse((await cli(state, 'inbox', '--json')).stdout).messages;
  expect(unread.every((m: any) => m.acknowledgedAt === null)).toBe(true);
  const source = await readFile(join(project, 'math.ts'), 'utf8');
  expect(source).toBe('export const add = (a: number, b: number) => a - b;\n');
  console.log(JSON.stringify({ nativeSmoke: 'passed', identitiesPreserved: true, messages: history.map((m) => ({ id: m.id, replyTo: m.replyTo })), unread: unread.map((m: any) => m.id) }));
  await cli(state, 'down', '--crew', 'sample');
}, 240000);

test('acknowledgment during preparation prevents queued input and delivery issue inspection stays participant scoped', async () => {
  const { directory, state, config, marker, release } = await deliveryFault('ack-race');
  await cli(state, 'up', config);
  await expect.poll(() => readFile(join(directory, 'current-draft.txt'), 'utf8').catch(() => null)).toBe('');
  const sent = JSON.parse((await cli(state, 'send', 'investigator', '--text', 'Ack before input.', '--json')).stdout);
  try {
    await expect.poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 8000 }).toBe('prepared');
    const credential = await readFile(join(directory, 'native-credential'), 'utf8');
    await exec(process.execPath, [cliPath, '--state-dir', state, 'ack', sent.id, '--json'], { env: { ...process.env, CREW_EXECUTION_TOKEN: credential } });
  } finally { await writeFile(release, 'release'); }
  await new Promise((resolve) => setTimeout(resolve, 650));
  expect(JSON.parse((await cli(state, 'message', 'show', sent.id, '--json')).stdout).deliveries[0].status).toBe('pending');
  expect(await readFile(join(directory, 'current-draft.txt'), 'utf8')).toBe('');
  await expect(readFile(join(directory, 'received.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const other = await multiFixture();
  await exec(process.execPath, [cliPath, '--state-dir', other.state, 'daemon', 'start'], { env: { ...process.env, CREW_CLAUDE_BIN: other.binary } });
  await cli(other.state, 'up', other.config);
  await expect.poll(async () => JSON.parse((await cli(other.state, 'status', '--json')).stdout).status).toBe('ready');
  const scoped = JSON.parse((await cli(other.state, 'send', 'coder', '--text', 'Private pending message.', '--json')).stdout);
  const reviewer = await readFile(join(other.directory, 'credential-reviewer'), 'utf8');
  const discovery = JSON.parse(await readFile(join(other.state, 'daemon.json'), 'utf8'));
  expect((await fetch(`${discovery.url}/messages/${scoped.id}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${reviewer}` }, body: '{}' })).status).toBe(404);
  expect((await (await fetch(`${discovery.url}/crews`, { headers: { Authorization: `Bearer ${reviewer}` } })).json()).deliveryIssues).toHaveLength(0);
}, 25000);
