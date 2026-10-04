import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
interface Crew {
  id: string;
  name: string;
  seats: { name: string; status: string; tmux: { socket: string; session: string } | null }[];
}

function requireTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('crew attach requires an interactive terminal.');
}

export async function attachSession(socket: string, session: string) {
  requireTerminal();
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const child = spawn('tmux', ['-S', socket, 'attach-session', '-t', `=${session}`], { stdio: 'inherit', env });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => { process.exitCode = code ?? 1; resolve(); });
  });
}

export async function attachCrew(directory: string, crew: Crew) {
  requireTerminal();
  const seats = crew.seats.filter((seat) => seat.tmux && seat.status !== 'failed');
  if (!seats.length) throw new Error(`Crew ${crew.name} has no active terminals.`);
  for (const seat of crew.seats.filter((seat) => !seats.includes(seat))) {
    console.error(`Skipping ${seat.name}: no active terminal (${seat.status}).`);
  }
  const socket = join(directory, 'views.sock');
  const session = `view-${crew.id}-${randomUUID()}`;
  const window = `${session}:0`;
  let previousPane = window;
  const tmux = (args: string[]) => exec('tmux', ['-S', socket, ...args], { timeout: 5000 });
  try {
    for (const [index, seat] of seats.entries()) {
      const terminal = seat.tmux!;
      const command = ['env', '-u', 'TMUX', '-u', 'TMUX_PANE', 'tmux', '-S', terminal.socket, 'attach-session', '-t', `=${terminal.session}`];
      const args = index === 0
        ? ['-f', '/dev/null', 'new-session', '-d', '-s', session, '-x', '160', '-y', '40']
        : ['split-window', '-d', '-t', previousPane];
      const pane = (await tmux([...args, '-P', '-F', '#{pane_id}', ...command])).stdout.trim();
      await tmux(['set-option', '-p', '-t', pane, '@crew_seat', seat.name]);
      previousPane = pane;
      await tmux(['select-layout', '-t', window, 'tiled']);
    }
    await tmux(['set-option', '-t', session, 'prefix', 'C-a']);
    await tmux(['set-option', '-t', session, 'mouse', 'on']);
    await tmux(['set-window-option', '-t', window, 'pane-border-status', 'top']);
    await tmux(['set-window-option', '-t', window, 'pane-border-format', '#{@crew_seat}']);
    console.log(`Crew ${crew.name}: click a pane or use Ctrl-a then an arrow. Ctrl-a then d detaches the view.`);
    await attachSession(socket, session);
  } finally {
    await tmux(['kill-session', '-t', `=${session}`]).catch((error: Error & { stderr?: string }) => {
      if (!/no server running|\(No such file or directory\)|\(Connection refused\)|can't find session/.test(error.stderr ?? '')) {
        console.error(`Could not close crew view: ${error.message}`);
      }
    });
  }
}

export async function detachCrew(directory: string, crew: Crew) {
  const socket = join(directory, 'views.sock');
  let sessions: string[];
  try {
    sessions = (await exec('tmux', ['-S', socket, 'list-sessions', '-F', '#{session_name}'], { timeout: 5000 })).stdout.trim().split('\n');
  } catch (error) {
    if (!/no server running|\(No such file or directory\)|\(Connection refused\)/.test((error as { stderr?: string }).stderr ?? '')) throw error;
    sessions = [];
  }
  for (const session of sessions.filter((session) => session.startsWith(`view-${crew.id}-`))) {
    await exec('tmux', ['-S', socket, 'kill-session', '-t', `=${session}`], { timeout: 5000 });
  }
  console.log(`Detached crew ${crew.name} views. The agents keep running.`);
}
