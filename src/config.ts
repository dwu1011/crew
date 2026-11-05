import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { resolveCapabilities } from './capabilities.js';

export const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const agentsSchema = z.record(nameSchema, z.object({
  runtime: z.literal('claude'),
  role_file: z.string().min(1),
  cwd: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).refine((items) => new Set(items).size === items.length, 'Duplicate skills').optional(),
  mcp_servers: z.array(z.string().min(1)).refine((items) => new Set(items).size === items.length, 'Duplicate MCP servers').optional(),
}).strict()).refine((agents) => Object.keys(agents).length > 0, 'A crew requires at least one seat');
const schema = z.object({
  name: nameSchema,
  project: z.string().min(1),
  agents: agentsSchema,
  mcp_config: z.string().min(1).optional(),
}).strict();

export async function projectDirectory(reference: string) {
  try {
    const path = await realpath(reference);
    if (!(await stat(path)).isDirectory()) throw new Error('not a directory');
    return path;
  } catch {
    throw new Error(`Invalid project: ${reference} must reference an existing directory`);
  }
}

export async function loadConfig(configPath: string) {
  let config: z.infer<typeof schema>;
  try {
    config = schema.parse(parse(await readFile(configPath, 'utf8')));
  } catch (error) {
    throw new Error(`Invalid crew configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
  const base = dirname(configPath);
  async function directory(reference: string, label: string) {
    try {
      const path = await realpath(resolve(base, reference));
      if (!(await stat(path)).isDirectory()) throw new Error('not a directory');
      return path;
    } catch {
      throw new Error(`Invalid ${label}: ${reference} must reference an existing directory`);
    }
  }
  const project = await directory(config.project, 'project');
  const agents = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    const cwd = agent.cwd ? await directory(agent.cwd, 'working directory') : project;
    const rolePath = resolve(base, agent.role_file);
    let role: string;
    try {
      role = await readFile(rolePath, 'utf8');
      if (!role.trim()) throw new Error('empty role');
    } catch {
      throw new Error(`Invalid role_file for ${name}: ${agent.role_file} must reference a readable, nonempty file`);
    }
    const capabilities = await resolveCapabilities(agent, base, config.mcp_config);
    agents.push({ name, runtime: agent.runtime, cwd, role, rolePath, capabilities });
  }
  return { name: config.name, project, agents, configPath };
}
