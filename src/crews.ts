import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HTTPException } from 'hono/http-exception';
import { processIdentity } from './process-identity.js';
import { processAlive } from './state.js';
import { loadConfig } from './config.js';
import { prepareAgentTerminal } from './terminal.js';
import { ManagedExecutions, type InputOptions, type InputSession } from './managed-executions.js';

const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const missingTerminal = /no server running|can't find|no such|\(No such file or directory\)|\(Connection refused\)/;
const processHasExited = (pid: number, identity: string | null) => {
  const current = processIdentity(pid);
  return current === null || identity === null ? !processAlive(pid) : current !== identity;
};

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
  state: 'active' | 'unknown' | 'stopping' | 'stopped';
  retryable: number;
  created_at: string;
  runtime_version: string | null;
}

export class Crews {
  private operations = new Map<string, Promise<unknown>>();
  private launches = new Set<Promise<unknown>>();
  readonly socket: string;
  private executions: ManagedExecutions;

  constructor(private db: Database.Database, private directory: string) {
    this.executions = new ManagedExecutions(db, directory);
    this.socket = this.executions.socket;
  }

  activity(executionId: string) {
    return this.executions.activity(executionId);
  }

  recordActivity(executionId: string, event: string, eventAt: string, toolName?: string) {
    return this.executions.recordActivity(executionId, event, eventAt, toolName);
  }

  private serial<T>(name: string, operation: () => Promise<T>) {
    const task = (this.operations.get(name) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.operations.set(name, task);
    task.finally(() => { if (this.operations.get(name) === task) this.operations.delete(name); }).catch(() => {});
    return task;
  }

  launch(configPath: string) {
    const task = this.launchCrew(configPath);
    this.launches.add(task);
    task.finally(() => this.launches.delete(task)).catch(() => {});
    return task;
  }

  async drain() {
    await Promise.allSettled([...this.launches, ...this.operations.values()]);
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
    return this.serial(config.name, async () => {
      const digest = hash(JSON.stringify({ project: config.project,
        agents: [...config.agents].sort((a, b) => a.name.localeCompare(b.name)), guidance }));
      const existing = this.db.prepare('SELECT id, config_digest FROM crews WHERE name = ?').get(config.name) as { id: string; config_digest: string | null } | undefined;
      if (existing && existing.config_digest !== digest) throw new HTTPException(409, { message: 'Crew configuration differs or its previous configuration cannot be confirmed; no executions were replaced.' });
      if (existing) await this.reconcileCrew(config.name);
      const crewId = existing?.id ?? randomUUID();
      const current = existing ? this.rows(crewId) : [];
      for (const execution of current) {
        if (execution.state === 'unknown') throw new HTTPException(409, { message: 'Execution state is unexplained; inspect crew status before replacing agents.' });
      }
      const agents: (typeof config.agents[number] & { seatId: string; executionId: string; generation: string; nativeSessionId: string; credential: string })[] = [];
      for (const agent of config.agents) {
        const occupant = current.find((seat) => seat.name === agent.name);
        if (occupant?.state === 'active' && ['ready', 'launching'].includes(occupant.status)) continue;
        if (occupant?.state === 'active' && !occupant.retryable) throw new HTTPException(409, { message: 'Execution state is unexplained; inspect crew status.' });
        if (occupant && occupant.state !== 'stopped') await this.stopExecution(occupant);
        agents.push({ ...agent, seatId: occupant?.seat_id ?? randomUUID(), executionId: randomUUID(), generation: randomUUID(), nativeSessionId: randomUUID(), credential: randomBytes(32).toString('hex') });
      }
      this.db.transaction(() => {
        if (!existing) this.db.prepare('INSERT INTO crews (id, name, project, config_path, config_digest) VALUES (?, ?, ?, ?, ?)')
          .run(crewId, config.name, config.project, config.configPath, digest);
        for (const agent of agents) {
          this.db.prepare('INSERT OR IGNORE INTO seats (id, crew_id, name, role_path, role) VALUES (?, ?, ?, ?, ?)')
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
          const version = (await exec(binary, ['--version'], { timeout: 5000 })).stdout.trim().match(/^(\d+\.\d+\.\d+)/)?.[1] ?? null;
          this.db.prepare('UPDATE executions SET runtime_version = ? WHERE id = ?').run(version, executionId);
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
            '# Coordination\nUse `crew whoami --json` to verify your identity, `crew members --json` to inspect teammates and their roles, and `crew status --json` to inspect current execution status. Use `crew send <seat> --text <body> --json` or `--body-file <path>` to persist a message. Use `--request-id <id>` to recover the same submission after a lost response. Use `crew inbox --json` and `crew message show <id> --json` to inspect messages without acknowledging them. These commands select your crew from your managed credential. Messages are persisted and queued for terminal delivery. Inspect delivery status: pending waits for safe input, submitted records native prompt verification of the saved delivery envelope, and uncertain may have affected input and will not retry automatically. Eligible pending work resumes after daemon restart. Inspect crew status for deliveryIssues and full attempt history. Explicit `crew message retry <id>` creates a new attempt for a definite failure; uncertain outcomes require `--allow-duplicate`. Acknowledged messages cannot be retried. Prompt verification does not acknowledge receipt or prove task completion. Use `crew ack <message-id> --json` to acknowledge receipt. Use `crew reply <message-id> --text <body> --json` (or --body-file) to send a linked reply and acknowledge the original atomically. Only the current recipient execution can acknowledge or reply. Operator-directed replies remain inspectable in the inbox. Only one agent should write project files at a time. Your role instructions do not alter native tool permissions.',
          ].join('\n\n');
          await writeFile(contextPath, context, { mode: 0o600 });
          const runner = fileURLToPath(new URL('./agent-runner.js', import.meta.url));
          const settingsPath = join(runtimeRoot, 'settings.json');
          await writeFile(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{
            type: 'command', command: `${quote(process.execPath)} ${quote(runner)} --hook`, timeout: 10,
          }] }], ...Object.fromEntries(['UserPromptSubmit', 'Stop', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].map((event) => [event,
            [{ hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(runner)} --hook`, timeout: 10 }] }]])) } }), { mode: 0o600 });
          const manifestPath = join(runtimeRoot, 'launch.json');
          await writeFile(manifestPath, JSON.stringify({
            executable, args: ['--session-id', nativeSessionId, '--append-system-prompt-file', contextPath, '--settings', settingsPath,
              ...(agent.cwd === config.project ? [] : ['--add-dir', config.project])],
            env: { CREW_HOME: this.directory, CREW_EXECUTION_TOKEN: credential, CREW_EXECUTION_ID: executionId,
              CREW_NAME: config.name, CREW_SEAT: agent.name, CREW_GENERATION: generation, CREW_EXECUTION_ROOT: runtimeRoot, PATH: `${join(runtimeRoot, 'bin')}:${process.env.PATH ?? ''}` },
          }), { mode: 0o600 });
          terminalAttempted = true;
          const result = await exec('tmux', ['-f', '/dev/null', '-S', this.socket, 'new-session', '-d', '-s', session,
            '-c', agent.cwd, '-x', '160', '-y', '40', '-P', '-F', '#{pane_id}', process.execPath, runner, manifestPath], { timeout: 5000 });
          const pane = result.stdout.trim();
          this.db.prepare('UPDATE executions SET tmux_session = ?, tmux_pane = ?, context_path = ? WHERE id = ?')
            .run(session, pane, contextPath, executionId);
          await prepareAgentTerminal(this.socket, session);
        } catch (error) {
          let failure = `Launch failed: ${(error as Error).message}`;
          if (terminalAttempted) {
            try {
              await exec('tmux', ['-S', this.socket, 'kill-session', '-t', session], { timeout: 2000 });
            } catch (cleanupError) {
              if (!missingTerminal.test((cleanupError as { stderr?: string }).stderr ?? ''))
                failure += `; Terminal cleanup failed: ${(cleanupError as Error).message}`;
            }
          }
          this.db.prepare("UPDATE executions SET status = 'failed', failure = ?, retryable = ? WHERE id = ?")
            .run(failure, failure.includes('Terminal cleanup failed') ? 0 : 1, executionId);
        }
      }));
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      if (rejected) throw rejected.reason;
      return this.status(config.name);
    });
  }

  private rows(crewId: string) {
    return this.db.prepare(`SELECT s.name, s.role_path, s.role, e.* FROM seats s JOIN executions e ON e.seat_id = s.id
      WHERE s.crew_id = ? AND e.rowid = (SELECT MAX(rowid) FROM executions WHERE seat_id = s.id)
      ORDER BY s.rowid`).all(crewId) as (Execution & { name: string; role: string | null })[];
  }

  private async reconcileCrew(name: string, startupGrace = true) {
    const crew = this.db.prepare('SELECT id FROM crews WHERE name = ?').get(name) as { id: string } | undefined;
    if (!crew) return;
    for (const execution of this.rows(crew.id)) {
      if (execution.state === 'stopped') continue;
      if (execution.state === 'stopping' && startupGrace) continue;
      const observed = await this.executions.inspect(execution);
      if (execution.state === 'stopping') {
        this.db.prepare('UPDATE executions SET state = ?, failure = ? WHERE id = ? AND state = ?')
          .run(observed.ownership === 'absent' ? 'stopped' : 'unknown', observed.ownership === 'absent' ? execution.failure : 'Crew shutdown was interrupted; process state must be checked', execution.id, 'stopping');
        continue;
      }
      if (startupGrace && execution.status === 'launching' && Date.now() - Date.parse(execution.created_at) < 10000
        && (!observed.receipt || (observed.ownership === 'owned' && observed.reason === 'Native process is missing or mismatched'))) continue;
      if (execution.status === 'failed') {
        if (!execution.retryable) this.db.prepare("UPDATE executions SET state = 'unknown' WHERE id = ? AND state IN ('active', 'unknown')").run(execution.id);
        continue;
      }
      if (observed.ownership !== 'owned' || observed.reason) {
        this.db.prepare("UPDATE executions SET state = 'unknown', failure = ? WHERE id = ? AND state = 'active' AND status IN ('launching', 'ready')")
          .run(observed.reason, execution.id);
      } else {
        this.db.prepare("UPDATE executions SET state = 'active', status = CASE WHEN ? = 1 THEN 'ready' ELSE status END, failure = NULL WHERE id = ? AND state IN ('active', 'unknown') AND status IN ('launching', 'ready')")
          .run(observed.ready ? 1 : 0, execution.id);
      }
    }
  }

  async reconcileAll() {
    for (const crew of this.db.prepare('SELECT id, name FROM crews').all() as { id: string; name: string }[]) {
      await this.reconcileCrew(crew.name, false);
      for (const execution of this.rows(crew.id).filter((row) => row.state === 'active' && ['launching', 'ready'].includes(row.status))) {
        await prepareAgentTerminal(this.socket, `crew-${execution.id}`);
      }
    }
  }

  withInput<T>(seatId: string, options: InputOptions, operation: (input: InputSession) => Promise<T>) {
    const crew = this.db.prepare('SELECT c.name FROM crews c JOIN seats s ON s.crew_id = c.id WHERE s.id = ?').get(seatId) as { name: string };
    return this.serial(crew.name, () => this.executions.withInput(seatId, options, operation));
  }

  private async stopExecution(execution: Execution) {
    if (execution.state === 'stopped') return;
    const observed = await this.executions.inspect(execution);
    if (observed.ownership === 'unknown') throw new HTTPException(409, { message: `Refusing to stop an unverified execution: ${observed.reason}` });
    this.db.prepare("UPDATE executions SET state = 'stopping' WHERE id = ?").run(execution.id);
    try {
      if (observed.ownership === 'owned') {
        await exec('tmux', ['-S', this.socket, 'kill-session', '-t', `=crew-${execution.id}`], { timeout: 2000 });
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const receipt = observed.receipt!;
          if (processHasExited(receipt.runnerPid, receipt.runnerIdentity)
            && (!receipt.nativePid || processHasExited(receipt.nativePid, receipt.nativeIdentity))) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!processHasExited(observed.receipt!.runnerPid, observed.receipt!.runnerIdentity)
          || (observed.receipt!.nativePid && !processHasExited(observed.receipt!.nativePid, observed.receipt!.nativeIdentity)))
          throw new Error('Managed processes have not exited after terminal shutdown');
      }
      this.db.prepare("UPDATE executions SET state = 'stopped' WHERE id = ? AND state = 'stopping'").run(execution.id);
    } catch (error) {
      this.db.prepare("UPDATE executions SET state = 'unknown', failure = ? WHERE id = ?").run((error as Error).message, execution.id);
      throw error;
    }
  }

  down(name: string) {
    return this.serial(name, async () => {
      const crew = this.db.prepare('SELECT id FROM crews WHERE name = ?').get(name) as { id: string } | undefined;
      if (!crew) throw new HTTPException(404, { message: 'Unknown crew' });
      const outcomes = await Promise.allSettled(this.rows(crew.id).map((execution) => this.stopExecution(execution)));
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      if (rejected) throw rejected.reason;
      return this.status(name);
    });
  }

  async status(name: string) {
    if (!this.operations.has(name)) await this.reconcileCrew(name);
    const crew = this.db.prepare('SELECT id, name, project FROM crews WHERE name = ?').get(name) as
      { id: string; name: string; project: string } | undefined;
    if (!crew) throw new HTTPException(404, { message: 'Unknown crew' });
    const seats = this.rows(crew.id);
    return { ...crew, status: seats.some((seat) => seat.state === 'unknown') ? 'unknown'
      : seats.some((seat) => seat.state === 'stopping') ? 'stopping'
      : seats.every((seat) => seat.state === 'stopped') ? 'stopped'
      : seats.some((seat) => seat.status === 'failed') ? 'failed'
      : seats.every((seat) => seat.state === 'active' && seat.status === 'ready') ? 'ready' : 'launching', seats: seats.map((seat) => ({
      name: seat.name, seatId: seat.seat_id, role: seat.role, roleFile: seat.role_path, runtime: 'claude', nativeVersion: seat.runtime_version, cwd: seat.cwd,
      executionId: seat.id, generation: seat.generation, nativeSessionId: seat.native_session_id,
      status: seat.state === 'active' ? seat.status : seat.state, failure: seat.failure, contextFile: seat.context_path, activity: this.activity(seat.id) ?? null,
      history: (this.db.prepare('SELECT id, generation, native_session_id, status, state, failure, created_at FROM executions WHERE seat_id = ? ORDER BY rowid').all(seat.seat_id) as { id: string; generation: string; native_session_id: string; status: string; state: string; failure: string | null; created_at: string }[])
        .map((execution) => ({ executionId: execution.id, generation: execution.generation, nativeSessionId: execution.native_session_id, status: execution.state === 'active' ? execution.status : execution.state, nativeStatus: execution.status, failure: execution.failure, createdAt: execution.created_at })),
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
    const crew = await this.status(name);
    const members = await Promise.all(crew.seats.map(async ({ name: seat, ...execution }) => ({
      seat, ...execution,
      role: execution.role ?? await readFile(execution.roleFile, 'utf8').catch(() => null),
    })));
    return { crew: crew.name, crewId: crew.id, status: crew.status, members };
  }

  private execution(credential: string, allowUnknown = false): Execution {
    const row = this.db.prepare(`SELECT e.*, s.name AS seat, s.role_path, c.name AS crew, c.id AS crew_id, c.project
      FROM executions e JOIN seats s ON s.id = e.seat_id JOIN crews c ON c.id = s.crew_id
      WHERE e.token_hash = ? AND (e.state = 'active' OR (? = 1 AND e.state = 'unknown')) AND e.status IN ('launching', 'ready')`).get(hash(credential), allowUnknown ? 1 : 0) as Execution | undefined;
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
    const execution = this.execution(credential, true);
    this.db.prepare("UPDATE executions SET status = 'failed', failure = ?, state = ?, retryable = ? WHERE id = ?")
      .run(reason, execution.status === 'launching' ? 'active' : 'unknown', execution.status === 'launching' ? 1 : 0, execution.id);
    return { status: 'failed' };
  }
}
