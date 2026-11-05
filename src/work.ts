import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

const text = z.string().trim().min(1);
const criterion = z.object({ id: text, assertion: text, verification: text }).strict();
export const taskContractSchema = z.object({
  scope: text, exclusions: z.array(text), criteria: z.array(criterion).min(1),
  outputs: z.array(text).min(1), selfChecks: z.array(text).min(1),
  route: z.enum(['small', 'standard', 'investigative']),
}).strict().refine((contract) => new Set(contract.criteria.map((item) => item.id)).size === contract.criteria.length,
  'Criterion IDs must be unique');
export const featureInputSchema = z.object({ title: text, goal: text, plannerSeat: text }).strict();
export const taskInputSchema = z.object({ featureId: z.string().uuid(), title: text, ownerSeat: text,
  kind: z.enum(['implementation', 'investigation', 'planning']), contract: taskContractSchema }).strict();
export const mutationSchema = z.object({ requestId: text.max(200), expectedVersion: z.number().int().positive(), reason: text }).strict();
export const createRequestSchema = z.object({ requestId: text.max(200) }).strict();
export const grantInputSchema = z.object({ executionId: z.string().uuid(), enabled: z.boolean() }).strict();
export type WorkCaller = { crew: string; seatId: string | null; executionId: string | null };

interface FeatureRow {
  id: string; crew_id: string; title: string; goal: string; planner_seat_id: string;
  phase: string; control: string; version: number; created_at: string; updated_at: string;
}
interface TaskRow {
  id: string; feature_id: string; owner_seat_id: string; title: string; kind: string;
  contract: string; contract_revision: number; state: string; control: string;
  version: number; created_at: string; updated_at: string;
}

export class Work {
  constructor(private db: Database.Database) {}

  private crew(caller: WorkCaller) {
    const row = this.db.prepare('SELECT id FROM crews WHERE name = ?').get(caller.crew) as { id: string } | undefined;
    if (!row) throw new HTTPException(404, { message: 'Unknown crew' });
    if (caller.executionId) {
      const execution = this.db.prepare(`SELECT e.id FROM executions e JOIN seats s ON s.id = e.seat_id
        WHERE e.id = ? AND e.seat_id = ? AND s.crew_id = ? AND s.retired = 0 AND e.state = 'active' AND e.status = 'ready'`)
        .get(caller.executionId, caller.seatId, row.id);
      if (!execution) throw new HTTPException(403, { message: 'Execution is not current and ready in this crew' });
    }
    return row.id;
  }

  private seat(crewId: string, name: string) {
    const row = this.db.prepare('SELECT id FROM seats WHERE crew_id = ? AND name = ? AND retired = 0').get(crewId, name) as { id: string } | undefined;
    if (!row) throw new HTTPException(404, { message: 'Unknown active seat in this crew' });
    return row.id;
  }

  private featureRow(crewId: string, id: string) {
    const row = this.db.prepare('SELECT * FROM features WHERE crew_id = ? AND id = ?').get(crewId, id) as FeatureRow | undefined;
    if (!row) throw new HTTPException(404, { message: 'Feature not found in your scope' });
    return row;
  }

  private taskRow(crewId: string, id: string) {
    const row = this.db.prepare('SELECT t.* FROM tasks t JOIN features f ON f.id = t.feature_id WHERE f.crew_id = ? AND t.id = ?')
      .get(crewId, id) as TaskRow | undefined;
    if (!row) throw new HTTPException(404, { message: 'Task not found in your scope' });
    return row;
  }

  private feature(row: FeatureRow) {
    return { id: row.id, title: row.title, goal: row.goal, plannerSeatId: row.planner_seat_id,
      phase: row.phase, control: row.control, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private task(row: TaskRow) {
    return { id: row.id, featureId: row.feature_id, title: row.title, ownerSeatId: row.owner_seat_id, kind: row.kind,
      contract: JSON.parse(row.contract), contractRevision: row.contract_revision, state: row.state, control: row.control,
      version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private events(crewId: string, featureId: string, taskId?: string) {
    const rows = this.db.prepare(`SELECT sequence, actor_execution_id AS actorExecutionId, request_id AS requestId,
      operation, reason, previous, result, created_at AS createdAt FROM work_events
      WHERE crew_id = ? AND feature_id = ? AND (? IS NULL OR task_id = ?) ORDER BY sequence`)
      .all(crewId, featureId, taskId ?? null, taskId ?? null) as { previous: string | null; result: string }[];
    return rows.map((row) => ({ ...row, previous: row.previous ? JSON.parse(row.previous) : null, result: JSON.parse(row.result) }));
  }

  listFeatures(caller: WorkCaller) {
    const rows = this.db.prepare('SELECT * FROM features WHERE crew_id = ? ORDER BY rowid').all(this.crew(caller)) as FeatureRow[];
    return { features: rows.map((row) => this.feature(row)) };
  }

  showFeature(caller: WorkCaller, id: string) {
    const crewId = this.crew(caller);
    return { ...this.feature(this.featureRow(crewId, id)),
      grants: this.db.prepare('SELECT execution_id AS executionId FROM planning_grants WHERE feature_id = ? ORDER BY execution_id').all(id),
      events: this.events(crewId, id) };
  }

  listTasks(caller: WorkCaller, featureId?: string) {
    const crewId = this.crew(caller);
    if (featureId) this.featureRow(crewId, featureId);
    const rows = this.db.prepare(`SELECT t.* FROM tasks t JOIN features f ON f.id = t.feature_id
      WHERE f.crew_id = ? AND (? IS NULL OR f.id = ?) ORDER BY t.rowid`).all(crewId, featureId ?? null, featureId ?? null) as TaskRow[];
    return { tasks: rows.map((row) => this.task(row)) };
  }

  showTask(caller: WorkCaller, id: string) {
    const crewId = this.crew(caller);
    const row = this.taskRow(crewId, id);
    return { ...this.task(row), events: this.events(crewId, row.feature_id, id) };
  }

  private planner(caller: WorkCaller, featureId: string) {
    if (caller.executionId && !this.db.prepare('SELECT 1 FROM planning_grants WHERE feature_id = ? AND execution_id = ?').get(featureId, caller.executionId))
      throw new HTTPException(403, { message: 'An operator-issued planning grant is required' });
  }

  private version(actual: number, expected: number) {
    if (actual !== expected) throw new HTTPException(409, { message: `Stale version; current version is ${actual}` });
  }

  private active(feature: FeatureRow) {
    if (feature.control !== 'active') throw new HTTPException(409, { message: `Feature is ${feature.control}` });
  }

  private mutate(caller: WorkCaller, requestId: string, payload: unknown, operation: (crewId: string) => unknown) {
    return this.db.transaction(() => {
      const crewId = this.crew(caller);
      const actorKey = caller.executionId ?? 'operator';
      const serialized = JSON.stringify(payload);
      const prior = this.db.prepare('SELECT payload, result FROM work_requests WHERE crew_id = ? AND actor_key = ? AND request_id = ?')
        .get(crewId, actorKey, requestId) as { payload: string; result: string } | undefined;
      if (prior) {
        if (prior.payload !== serialized) throw new HTTPException(409, { message: 'Request identifier was already used with different content' });
        return JSON.parse(prior.result);
      }
      const result = operation(crewId);
      this.db.prepare('INSERT INTO work_requests (crew_id, actor_key, request_id, payload, result) VALUES (?, ?, ?, ?, ?)')
        .run(crewId, actorKey, requestId, serialized, JSON.stringify(result));
      return result;
    }).immediate();
  }

  private event(caller: WorkCaller, crewId: string, featureId: string, taskId: string | null, requestId: string,
    operation: string, reason: string, previous: unknown, result: unknown) {
    this.db.prepare(`INSERT INTO work_events (crew_id, feature_id, task_id, actor_execution_id, request_id, operation,
      reason, previous, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(crewId, featureId, taskId, caller.executionId, requestId, operation, reason,
        previous === null ? null : JSON.stringify(previous), JSON.stringify(result), new Date().toISOString());
  }

  createFeature(caller: WorkCaller, input: z.infer<typeof featureInputSchema>, requestId: string) {
    return this.mutate(caller, requestId, { operation: 'feature.create', input }, (crewId) => {
      if (caller.executionId) throw new HTTPException(403, { message: 'Only the operator can submit a feature' });
      const id = randomUUID(), now = new Date().toISOString();
      this.db.prepare(`INSERT INTO features (id, crew_id, title, goal, planner_seat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, crewId, input.title, input.goal, this.seat(crewId, input.plannerSeat), now, now);
      this.event(caller, crewId, id, null, requestId, 'feature.create', 'Operator intake', null, this.feature(this.featureRow(crewId, id)));
      return this.showFeature(caller, id);
    });
  }

  setGrant(caller: WorkCaller, id: string, input: z.infer<typeof grantInputSchema>, mutation: z.infer<typeof mutationSchema>) {
    return this.mutate(caller, mutation.requestId, { operation: 'feature.grant', id, input, mutation }, (crewId) => {
      if (caller.executionId) throw new HTTPException(403, { message: 'Only the operator can change planning grants' });
      const feature = this.featureRow(crewId, id);
      this.version(feature.version, mutation.expectedVersion);
      if (feature.control === 'cancelled') throw new HTTPException(409, { message: 'Feature is cancelled' });
      const execution = this.db.prepare(`SELECT e.id FROM executions e JOIN seats s ON s.id = e.seat_id
        WHERE e.id = ? AND s.crew_id = ? AND s.retired = 0 AND e.state = 'active' AND e.status = 'ready'`).get(input.executionId, crewId);
      if (input.enabled && !execution) throw new HTTPException(409, { message: 'Grant recipient must be a current ready execution in this crew' });
      if (input.enabled) this.db.prepare('INSERT OR IGNORE INTO planning_grants (feature_id, execution_id) VALUES (?, ?)').run(id, input.executionId);
      else this.db.prepare('DELETE FROM planning_grants WHERE feature_id = ? AND execution_id = ?').run(id, input.executionId);
      this.db.prepare('UPDATE features SET version = version + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      this.event(caller, crewId, id, null, mutation.requestId, 'feature.grant', mutation.reason, this.feature(feature),
        { ...this.feature(this.featureRow(crewId, id)), grant: input });
      return this.showFeature(caller, id);
    });
  }

  createTask(caller: WorkCaller, input: z.infer<typeof taskInputSchema>, requestId: string) {
    return this.mutate(caller, requestId, { operation: 'task.create', input }, (crewId) => {
      const feature = this.featureRow(crewId, input.featureId);
      this.planner(caller, feature.id);
      this.active(feature);
      const id = randomUUID(), now = new Date().toISOString();
      this.db.prepare(`INSERT INTO tasks (id, feature_id, owner_seat_id, title, kind, contract, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, feature.id, this.seat(crewId, input.ownerSeat), input.title, input.kind, JSON.stringify(input.contract), now, now);
      this.event(caller, crewId, feature.id, id, requestId, 'task.create', 'Contract prepared', null, this.task(this.taskRow(crewId, id)));
      return this.showTask(caller, id);
    });
  }

  taskAction(caller: WorkCaller, id: string, action: 'ready' | 'pause' | 'resume' | 'cancel', mutation: z.infer<typeof mutationSchema>) {
    return this.mutate(caller, mutation.requestId, { operation: `task.${action}`, id, mutation }, (crewId) => {
      const task = this.taskRow(crewId, id), feature = this.featureRow(crewId, task.feature_id);
      this.planner(caller, feature.id);
      this.version(task.version, mutation.expectedVersion);
      if (['integrated', 'accepted', 'cancelled', 'superseded'].includes(task.state)) throw new HTTPException(409, { message: 'Task is terminal' });
      if (caller.executionId && action === 'cancel') throw new HTTPException(403, { message: 'Agent cancellation requires reviewed plan revisions, which are not implemented' });
      if (!['draft', 'ready'].includes(task.state)) throw new HTTPException(409, { message: 'Active attempts require reconciliation, which is not implemented' });
      if (action !== 'cancel') this.active(feature);
      let state = task.state, control = task.control;
      if (action === 'ready') {
        if (state !== 'draft' || control !== 'active') throw new HTTPException(409, { message: 'Only an active draft can become ready' });
        const contract = taskContractSchema.parse(JSON.parse(task.contract));
        if (contract.route !== 'small') throw new HTTPException(409, { message: 'This route requires reviewed plans, which are not implemented' });
        if (!this.db.prepare('SELECT id FROM seats WHERE id = ? AND retired = 0').get(task.owner_seat_id))
          throw new HTTPException(409, { message: 'Task owner seat is retired' });
        state = 'ready';
      } else if (action === 'cancel') state = 'cancelled';
      else {
        const next = action === 'pause' ? 'paused' : 'active';
        if (control === next) throw new HTTPException(409, { message: `Task is already ${next}` });
        if (action === 'resume' && caller.executionId) throw new HTTPException(403, { message: 'Only the operator can resume paused tasks in this increment' });
        control = next;
      }
      this.db.prepare('UPDATE tasks SET state = ?, control = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(state, control, new Date().toISOString(), id);
      this.event(caller, crewId, feature.id, id, mutation.requestId, `task.${action}`, mutation.reason, this.task(task), this.task(this.taskRow(crewId, id)));
      return this.showTask(caller, id);
    });
  }

  featureAction(caller: WorkCaller, id: string, action: 'pause' | 'resume' | 'cancel', mutation: z.infer<typeof mutationSchema>) {
    return this.mutate(caller, mutation.requestId, { operation: `feature.${action}`, id, mutation }, (crewId) => {
      if (caller.executionId) throw new HTTPException(403, { message: 'Only the operator can control features in this increment' });
      const feature = this.featureRow(crewId, id);
      this.version(feature.version, mutation.expectedVersion);
      if (feature.control === 'cancelled') throw new HTTPException(409, { message: 'Feature is cancelled' });
      const control = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled';
      if (feature.control === control) throw new HTTPException(409, { message: `Feature is already ${control}` });
      if (this.db.prepare("SELECT 1 FROM tasks WHERE feature_id = ? AND state NOT IN ('draft', 'ready', 'cancelled', 'superseded')").get(id))
        throw new HTTPException(409, { message: 'Advanced work requires reconciliation, which is not implemented' });
      this.db.prepare('UPDATE features SET control = ?, version = version + 1, updated_at = ? WHERE id = ?').run(control, new Date().toISOString(), id);
      if (action === 'cancel') {
        for (const task of this.db.prepare("SELECT * FROM tasks WHERE feature_id = ? AND state IN ('draft', 'ready')").all(id) as TaskRow[]) {
          this.db.prepare("UPDATE tasks SET state = 'cancelled', version = version + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), task.id);
          this.event(caller, crewId, id, task.id, mutation.requestId, 'task.cancel', mutation.reason, this.task(task), this.task(this.taskRow(crewId, task.id)));
        }
      }
      this.event(caller, crewId, id, null, mutation.requestId, `feature.${action}`, mutation.reason, this.feature(feature), this.feature(this.featureRow(crewId, id)));
      return this.showFeature(caller, id);
    });
  }
}
