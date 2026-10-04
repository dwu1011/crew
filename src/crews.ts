import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HTTPException } from 'hono/http-exception';
import { loadConfig } from './config.js';

const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

interface Execution {
  id: string;
  generation: string;
  native_session_id: string;
  status: 'launching' | 'ready' | 'failed';
  cwd: string;
  failure: string | null;
  context_path: string | null;
  tmux_session: string | null;
  tmux_pane: string | null;
  seat: string;
  crew: string;
  crew_id: string;
  seat_id: string;
  project: string;
  role_path: string;
}

export class Crews {
  private launches = new Set<Promise<unknown>>();
  readonly socket: string;

  constructor(private db: Database.Database, private directory: string) {
    this.socket = join(directory, 'tmux.sock');
    db.transaction(() => {
      if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('002_single_seat')) return;
      db.exec(`
        CREATE TABLE crews (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, project TEXT NOT NULL, config_path TEXT NOT NULL);
        CREATE TABLE seats (id TEXT PRIMARY KEY, crew_id TEXT NOT NULL REFERENCES crews(id), name TEXT NOT NULL,
          role_path TEXT NOT NULL, UNIQUE(crew_id, name));
        CREATE TABLE executions (id TEXT PRIMARY KEY, seat_id TEXT NOT NULL REFERENCES seats(id),
          generation TEXT NOT NULL UNIQUE, native_session_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK (status IN ('launching', 'ready', 'failed')), cwd TEXT NOT NULL,
          failure TEXT, context_path TEXT, tmux_session TEXT, tmux_pane TEXT,
          created_at TEXT NOT NULL, ready_at TEXT);
        CREATE UNIQUE INDEX execution_one_active ON executions(seat_id) WHERE status IN ('launching', 'ready');
      `);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
        .run('002_single_seat', new Date().toISOString());
    }).immediate();
    db.transaction(() => {
      if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get('003_seat_roles')) return;
      db.exec('ALTER TABLE seats ADD COLUMN role TEXT');
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
        .run('003_seat_roles', new Date().toISOString());
    }).immediate();
  }

  launch(configPath: string) {
    const task = this.launchCrew(configPath);
    this.launches.add(task);
    task.finally(() => this.launches.delete(task)).catch(() => {});
    return task;
  }

  async drain() {
    await Promise.allSettled([...this.launches]);
  }

  private async launchCrew(configPath: string) {
    let config: Awaited<ReturnType<typeof loadConfig>>;
    try {
      config = await loadConfig(configPath);
    } catch (error) {
      throw new HTTPException(400, { message: (error as Error).message });
    }
    const guidance: string[] = [];
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      try {
        guidance.push(`## Project guidance: ${file}\n${await readFile(join(config.project, file), 'utf8')}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new HTTPException(400, { message: `Cannot read project guidance ${file}` });
        }
      }
    }
    const existing = this.db.prepare('SELECT id FROM crews WHERE name = ?').get(config.name) as { id: string } | undefined;
    if (existing) throw new HTTPException(409, { message: 'Crew already exists; repeated startup is supported in ticket 4.' });
    const crewId = randomUUID();
    const agents = config.agents.map((agent) => ({ ...agent,
      seatId: randomUUID(), executionId: randomUUID(), generation: randomUUID(),
      nativeSessionId: randomUUID(), credential: randomBytes(32).toString('hex'),
    }));
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO crews (id, name, project, config_path) VALUES (?, ?, ?, ?)')
        .run(crewId, config.name, config.project, config.configPath);
      for (const agent of agents) {
        this.db.prepare('INSERT INTO seats (id, crew_id, name, role_path, role) VALUES (?, ?, ?, ?, ?)')
          .run(agent.seatId, crewId, agent.name, agent.rolePath, agent.role);
        this.db.prepare(`INSERT INTO executions (id, seat_id, generation, native_session_id, token_hash, status, cwd, created_at)
          VALUES (?, ?, ?, ?, ?, 'launching', ?, ?)`)
          .run(agent.executionId, agent.seatId, agent.generation, agent.nativeSessionId, hash(agent.credential), agent.cwd, new Date().toISOString());
      }
    }).immediate();

    const outcomes = await Promise.allSettled(agents.map(async (agent) => {
      const { executionId, generation, nativeSessionId, credential } = agent;
      const session = `crew-${executionId}`;
      const runtimeRoot = join(this.directory, 'executions', executionId);
      const contextPath = join(runtimeRoot, 'context.md');
      let terminalAttempted = false;
      try {
        const binary = process.env.CREW_CLAUDE_BIN ?? 'claude';
        await exec(binary, ['--version'], { timeout: 5000 });
        const executable = binary.includes('/') ? resolve(binary) : (await exec('which', [binary], { timeout: 5000 })).stdout.trim();
        await mkdir(join(runtimeRoot, 'bin'), { recursive: true, mode: 0o700 });
        const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
        await writeFile(join(runtimeRoot, 'bin', 'crew'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o700 });
        const context = [
          `# Crew role\n${agent.role}`,
          `# Managed identity\nCrew: ${config.name}\nSeat: ${agent.name}\nExecution: ${executionId}\nGeneration: ${generation}`,
          `# Project\nProject root: ${config.project}\nWorking directory: ${agent.cwd}`,
          ...guidance,
          `# Crew roster\n${JSON.stringify(config.agents.map((teammate) => ({ seat: teammate.name, runtime: teammate.runtime, role: teammate.role })), null, 2)}`,
          '# Coordination\nUse `crew whoami --json` to verify your identity, `crew members --json` to inspect teammates and their roles, and `crew status --json` to inspect current execution status. These commands select your crew from your managed credential. Messaging is not implemented yet; do not claim that you sent messages. Only one agent should write project files at a time. Your role instructions do not alter native tool permissions.',
        ].join('\n\n');
        await writeFile(contextPath, context, { mode: 0o600 });
        const runner = fileURLToPath(new URL('./agent-runner.js', import.meta.url));
        const settingsPath = join(runtimeRoot, 'settings.json');
        await writeFile(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{
          type: 'command', command: `${quote(process.execPath)} ${quote(runner)} --hook`, timeout: 10,
        }] }] } }), { mode: 0o600 });
        const manifestPath = join(runtimeRoot, 'launch.json');
        await writeFile(manifestPath, JSON.stringify({
          executable, args: ['--session-id', nativeSessionId, '--append-system-prompt-file', contextPath, '--settings', settingsPath,
            ...(agent.cwd === config.project ? [] : ['--add-dir', config.project])],
          env: { CREW_HOME: this.directory, CREW_EXECUTION_TOKEN: credential, CREW_EXECUTION_ID: executionId,
            CREW_NAME: config.name, CREW_SEAT: agent.name, PATH: `${join(runtimeRoot, 'bin')}:${process.env.PATH ?? ''}` },
        }), { mode: 0o600 });
        terminalAttempted = true;
        const result = await exec('tmux', ['-f', '/dev/null', '-S', this.socket, 'new-session', '-d', '-s', session,
          '-c', agent.cwd, '-x', '160', '-y', '40', '-P', '-F', '#{pane_id}', process.execPath, runner, manifestPath], { timeout: 5000 });
        const pane = result.stdout.trim();
        this.db.prepare('UPDATE executions SET tmux_session = ?, tmux_pane = ?, context_path = ? WHERE id = ?')
          .run(session, pane, contextPath, executionId);
      } catch (error) {
        let failure = `Launch failed: ${(error as Error).message}`;
        if (terminalAttempted) {
          try {
            await exec('tmux', ['-S', this.socket, 'kill-session', '-t', session], { timeout: 2000 });
          } catch (cleanupError) {
            failure += `; Terminal cleanup failed: ${(cleanupError as Error).message}`;
          }
        }
        this.db.prepare("UPDATE executions SET status = 'failed', failure = ? WHERE id = ?")
          .run(failure, executionId);
      }
    }));
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejected) throw rejected.reason;
    return this.status(config.name);
  }

  status(name: string) {
    const crew = this.db.prepare('SELECT id, name, project FROM crews WHERE name = ?').get(name) as
      { id: string; name: string; project: string } | undefined;
    if (!crew) throw new HTTPException(404, { message: 'Unknown crew' });
    const seats = this.db.prepare(`SELECT s.name, s.role_path, s.role, e.* FROM seats s JOIN executions e ON e.seat_id = s.id
      WHERE s.crew_id = ? ORDER BY e.created_at, s.rowid`).all(crew.id) as (Execution & { name: string; role: string | null })[];
    return { ...crew, status: seats.some((seat) => seat.status === 'failed') ? 'failed'
      : seats.every((seat) => seat.status === 'ready') ? 'ready' : 'launching', seats: seats.map((seat) => ({
      name: seat.name, seatId: seat.seat_id, role: seat.role, roleFile: seat.role_path, runtime: 'claude', cwd: seat.cwd,
      executionId: seat.id, generation: seat.generation, nativeSessionId: seat.native_session_id,
      status: seat.status, failure: seat.failure, contextFile: seat.context_path,
      tmux: seat.tmux_session ? { socket: this.socket, session: seat.tmux_session, pane: seat.tmux_pane } : null,
    })) };
  }

  select(name?: string) {
    if (name) return name;
    const crews = this.db.prepare('SELECT name FROM crews ORDER BY name').all() as { name: string }[];
    if (crews.length === 0) throw new HTTPException(404, { message: 'No crews exist; launch one with crew up' });
    if (crews.length !== 1) throw new HTTPException(409, { message: 'Multiple crews exist; select one with --crew <name>' });
    return crews[0].name;
  }

  async members(name: string) {
    const crew = this.status(name);
    const members = await Promise.all(crew.seats.map(async ({ name: seat, ...execution }) => ({
      seat, ...execution,
      role: execution.role ?? await readFile(execution.roleFile, 'utf8').catch(() => null),
    })));
    return { crew: crew.name, crewId: crew.id, status: crew.status, members };
  }

  private execution(credential: string): Execution {
    const row = this.db.prepare(`SELECT e.*, s.name AS seat, s.role_path, c.name AS crew, c.id AS crew_id, c.project
      FROM executions e JOIN seats s ON s.id = e.seat_id JOIN crews c ON c.id = s.crew_id
      WHERE e.token_hash = ? AND e.status IN ('launching', 'ready')`).get(hash(credential)) as Execution | undefined;
    if (!row) throw new HTTPException(401, { message: 'Invalid or inactive execution credential' });
    return row;
  }

  whoami(credential: string) {
    const execution = this.execution(credential);
    return { crew: execution.crew, crewId: execution.crew_id, seat: execution.seat, seatId: execution.seat_id,
      executionId: execution.id, generation: execution.generation, nativeSessionId: execution.native_session_id,
      runtime: 'claude', cwd: execution.cwd, status: execution.status };
  }

  ready(credential: string, sessionId: string, cwd: string) {
    const execution = this.execution(credential);
    if (execution.native_session_id !== sessionId || execution.cwd !== cwd) {
      throw new HTTPException(409, { message: 'Native startup identity does not match the managed execution' });
    }
    this.db.prepare("UPDATE executions SET status = 'ready', ready_at = ? WHERE id = ? AND status = 'launching'")
      .run(new Date().toISOString(), execution.id);
    return this.whoami(credential);
  }

  exited(credential: string, reason: string) {
    const execution = this.execution(credential);
    this.db.prepare("UPDATE executions SET status = 'failed', failure = ? WHERE id = ?").run(reason, execution.id);
    return { status: 'failed' };
  }
}
