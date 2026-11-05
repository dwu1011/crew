import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { agentsSchema, nameSchema, projectDirectory } from './config.js';
import { planningRoles } from './planning.js';
import { inheritedCapabilities, resolveCapabilities } from './capabilities.js';

const schema = z.object({ name: nameSchema, agents: agentsSchema, mcp_config: z.string().min(1).optional() }).strict();
interface ProfileRow { id: string; name: string; source_path: string | null }

export interface RunSelector { crew?: string; profile?: string; project?: string }

export class Profiles {
  constructor(private db: Database.Database) {}

  private row(name: string) {
    const row = this.db.prepare('SELECT * FROM profiles WHERE name = ? OR id = ?').get(name, name) as ProfileRow | undefined;
    if (!row) throw new HTTPException(404, { message: `Unknown profile ${name}; use crew profile list` });
    return row;
  }

  private async definition(profile: ProfileRow): Promise<z.infer<typeof schema>> {
    if (profile.source_path === null) return {
      name: profile.name,
      agents: Object.fromEntries(Object.keys(planningRoles).map((name) => [name, { runtime: 'claude' as const, role_file: `builtin:planning/${name}` }])),
    };
    try {
      const definition = schema.parse(parse(await readFile(profile.source_path, 'utf8')));
      if (definition.name !== profile.name) throw new Error('Registered profile name changed; register the new name explicitly');
      return definition;
    } catch (error) {
      throw new HTTPException(400, { message: `Invalid profile: ${(error as Error).message}. Profiles contain name, agents, and optional mcp_config; project is supplied at launch.` });
    }
  }

  private async agents(profile: ProfileRow, project?: string) {
    const definition = await this.definition(profile);
    return Promise.all(Object.entries(definition.agents).map(async ([name, agent]) => {
      const rolePath = profile.source_path === null ? agent.role_file : resolve(dirname(profile.source_path), agent.role_file);
      let role: string;
      try {
        role = profile.source_path === null ? planningRoles[name as keyof typeof planningRoles] : await readFile(rolePath, 'utf8');
        if (!role.trim()) throw new Error('empty role');
      } catch { throw new HTTPException(400, { message: `Invalid role_file for ${name}: ${agent.role_file} must reference a readable, nonempty file` }); }
      let cwd = project;
      if (agent.cwd) {
        if (isAbsolute(agent.cwd) || agent.cwd.split(/[\\/]/).includes('..')) throw new HTTPException(400, { message: 'Profile working directories must be relative paths within the project' });
        if (project) {
          cwd = await projectDirectory(resolve(project, agent.cwd)).catch((error: Error) => { throw new HTTPException(400, { message: error.message }); });
          const difference = relative(project, cwd);
          if (difference === '..' || difference.startsWith(`..${sep}`) || isAbsolute(difference)) throw new HTTPException(400, { message: 'Profile working directory escapes the project' });
        }
      }
      let capabilities: Awaited<ReturnType<typeof resolveCapabilities>>;
      try {
        capabilities = await resolveCapabilities(agent, profile.source_path === null ? process.cwd() : dirname(profile.source_path), definition.mcp_config);
      } catch (error) { throw new HTTPException(400, { message: (error as Error).message }); }
      return { name, runtime: agent.runtime, rolePath, role, cwd, workingDirectory: agent.cwd ?? '.', capabilities };
    }));
  }

  async register(source: string) {
    let sourcePath: string;
    let definition: z.infer<typeof schema>;
    try {
      sourcePath = await realpath(source);
      definition = schema.parse(parse(await readFile(sourcePath, 'utf8')));
    } catch (error) { throw new HTTPException(400, { message: `Invalid profile: ${(error as Error).message}. Profiles contain name, agents, and optional mcp_config; project is supplied at launch.` }); }
    const existing = this.db.prepare('SELECT * FROM profiles WHERE name = ?').get(definition.name) as ProfileRow | undefined;
    if (existing && existing.source_path !== sourcePath) throw new HTTPException(409, { message: `Profile ${definition.name} is already registered from another source` });
    const profile = existing ?? { id: randomUUID(), name: definition.name, source_path: sourcePath };
    await this.agents(profile);
    this.db.transaction(() => {
      const registered = this.db.prepare('SELECT source_path FROM profiles WHERE name = ?').get(profile.name) as { source_path: string | null } | undefined;
      if (registered && registered.source_path !== sourcePath) throw new HTTPException(409, { message: `Profile ${profile.name} is already registered from another source` });
      if (!registered) this.db.prepare('INSERT INTO profiles (id, name, source_path) VALUES (?, ?, ?)').run(profile.id, profile.name, sourcePath);
    }).immediate();
    return this.show(profile.name);
  }

  list() {
    return { profiles: (this.db.prepare('SELECT * FROM profiles ORDER BY name').all() as ProfileRow[])
      .map((row) => ({ id: row.id, name: row.name, source: row.source_path, builtin: row.source_path === null })) };
  }

  async show(name: string) {
    const profile = this.row(name);
    return { id: profile.id, name: profile.name, source: profile.source_path, builtin: profile.source_path === null,
      projectBinding: 'supplied at launch', seats: (await this.agents(profile)).map(({ capabilities, ...agent }) => ({
        ...agent, capabilities: capabilities?.summary ?? inheritedCapabilities,
      })) };
  }

  async launch(name: string, root: string) {
    const profile = this.row(name);
    const project = await projectDirectory(root).catch((error: Error) => { throw new HTTPException(400, { message: error.message }); });
    const agents = (await this.agents(profile, project)).map((agent) => ({ ...agent, cwd: agent.cwd! }));
    const existing = this.db.prepare('SELECT name FROM crews WHERE profile_id = ? AND project = ?').get(profile.id, project) as { name: string } | undefined;
    const prefix = `${profile.name}-${basename(project)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50);
    const crewName = existing?.name ?? `${prefix}-${randomUUID().slice(0, 12)}`;
    return { name: crewName, project, agents, configPath: profile.source_path ?? 'builtin:planning', profileId: profile.id };
  }

  async select(selector: RunSelector) {
    if (selector.crew) return selector.crew;
    const profile = selector.profile ? this.row(selector.profile) : undefined;
    let runs = this.db.prepare(`SELECT c.name, c.project, p.id AS profile_id, p.name AS profile
      FROM crews c JOIN profiles p ON p.id = c.profile_id`).all() as { name: string; project: string; profile_id: string; profile: string }[];
    if (selector.project) {
      const project = await projectDirectory(selector.project).catch((error: Error) => { throw new HTTPException(400, { message: error.message }); });
      runs = runs.filter((run) => {
        const difference = relative(run.project, project);
        return difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
      });
      const deepest = Math.max(...runs.map((run) => run.project.length));
      runs = runs.filter((run) => run.project.length === deepest);
    }
    if (profile) runs = runs.filter((run) => run.profile_id === profile.id);
    if (runs.length === 1) return runs[0].name;
    if (runs.length > 1) throw new HTTPException(409, { message: `Multiple project runs match; select --profile or --crew: ${runs.map((run) => `${run.name} (${run.profile}, ${run.project})`).join(', ')}` });
    if (profile || this.db.prepare('SELECT 1 FROM crews WHERE profile_id IS NOT NULL').get()) {
      throw new HTTPException(404, { message: 'No project run matches; use crew up --profile <name> or select --crew <name>' });
    }
    return undefined;
  }

  async assertScope(crew: string, selector: RunSelector) {
    const run = this.db.prepare('SELECT profile_id, project FROM crews WHERE name = ?').get(crew) as { profile_id: string | null; project: string };
    if (selector.crew && selector.crew !== crew) throw new HTTPException(403, { message: 'Managed executions can only inspect their own crew' });
    if (selector.profile && this.row(selector.profile).id !== run.profile_id) throw new HTTPException(403, { message: 'Managed execution profile mismatch' });
    if (selector.project) {
      const project = await projectDirectory(selector.project).catch(() => null);
      if (project !== run.project) throw new HTTPException(403, { message: 'Managed execution project mismatch' });
    }
  }
}
