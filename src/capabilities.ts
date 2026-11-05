import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const serverSchema = z.union([
  z.object({ type: z.literal('stdio').optional(), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }).passthrough(),
  z.object({ type: z.enum(['http', 'sse']), url: z.string().min(1), headers: z.record(z.string(), z.string()).optional() }).passthrough(),
]);

export interface CapabilitySummary {
  skills: { mode: 'inherited' } | { mode: 'selected'; items: { name: string; description: string; source: string; digest: string }[] };
  mcpServers: { mode: 'inherited' } | { mode: 'selected'; names: string[]; digest: string };
}

export interface Capabilities {
  summary: CapabilitySummary;
  skills?: { name: string; files: { path: string; content: string; executable: boolean }[] }[];
  mcpServers?: Record<string, z.infer<typeof serverSchema>>;
}

export const inheritedCapabilities: CapabilitySummary = { skills: { mode: 'inherited' }, mcpServers: { mode: 'inherited' } };

export async function resolveCapabilities(selection: { skills?: string[]; mcp_servers?: string[] }, base: string, mcpConfig?: string): Promise<Capabilities | undefined> {
  if (selection.skills === undefined && selection.mcp_servers === undefined) return undefined;
  const capabilities: Capabilities = { summary: { ...inheritedCapabilities } };
  if (selection.skills !== undefined) {
    capabilities.skills = [];
    const items: Extract<CapabilitySummary['skills'], { mode: 'selected' }>['items'] = [];
    for (const reference of selection.skills) {
      const candidates = isAbsolute(reference) || reference.includes('/') || reference.startsWith('.')
        ? [resolve(base, reference)]
        : [join(base, '.claude', 'skills', reference), join(base, '.agents', 'skills', reference),
          join(homedir(), '.claude', 'skills', reference), join(homedir(), '.agents', 'skills', reference)];
      let source: string | undefined;
      for (const candidate of candidates) {
        try { source = await realpath(candidate); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot resolve skill ${reference}`); }
      }
      if (!source) throw new Error(`Unknown skill ${reference}`);
      try {
        if (!(await lstat(source)).isDirectory()) throw new Error('Expected a skill directory');
        const text = await readFile(join(source, 'SKILL.md'), 'utf8');
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        if (!frontmatter) throw new Error('SKILL.md requires YAML frontmatter');
        const metadata = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), description: z.string().trim().min(1) }).parse(parse(frontmatter[1]));
        if (items.some((item) => item.name === metadata.name)) throw new Error('Duplicate skill name');
        const files: { path: string; content: string; executable: boolean }[] = [];
        async function collect(directory: string, prefix: string) {
          for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(prefix, entry.name);
            if (entry.isDirectory()) await collect(join(directory, entry.name), path);
            else if (entry.isFile()) files.push({ path, content: (await readFile(join(directory, entry.name))).toString('base64'),
              executable: ((await lstat(join(directory, entry.name))).mode & 0o111) !== 0 });
            else throw new Error('Skill resources must be regular files or directories');
          }
        }
        await collect(source, '');
        items.push({ ...metadata, source, digest: digest(files) });
        capabilities.skills.push({ name: metadata.name, files });
      } catch {
        throw new Error(`Invalid skill ${reference}: require a directory with readable regular resources and SKILL.md with a unique name and description`);
      }
    }
    capabilities.summary.skills = { mode: 'selected', items };
  }
  if (selection.mcp_servers !== undefined) {
    const selected: NonNullable<Capabilities['mcpServers']> = {};
    if (selection.mcp_servers.length) {
      if (!mcpConfig) throw new Error('mcp_config is required when selecting MCP servers');
      let servers: Record<string, unknown>;
      try {
        const config = JSON.parse(await readFile(resolve(base, mcpConfig), 'utf8'));
        servers = z.record(z.string(), z.unknown()).parse(config.mcpServers);
      } catch { throw new Error('Cannot read mcp_config: expected JSON with an mcpServers object'); }
      for (const name of selection.mcp_servers) {
        if (!Object.hasOwn(servers, name)) throw new Error(`Unknown MCP server ${name}`);
        const parsed = serverSchema.safeParse(servers[name]);
        if (!parsed.success) throw new Error(`Invalid MCP server ${name}: expected a stdio, http, or sse definition`);
        Object.defineProperty(selected, name, { value: parsed.data, enumerable: true });
      }
    }
    capabilities.mcpServers = selected;
    capabilities.summary.mcpServers = { mode: 'selected', names: Object.keys(selected), digest: digest(selected) };
  }
  return capabilities;
}

export async function snapshotCapabilities(capabilities: Capabilities | undefined, root: string) {
  const args: string[] = [];
  let context = '';
  if (capabilities?.skills !== undefined) {
    args.push('--disable-slash-commands');
    const catalog = [];
    for (const skill of capabilities.skills) {
      const directory = join(root, 'skills', skill.name);
      for (const file of skill.files) {
        await mkdir(dirname(join(directory, file.path)), { recursive: true, mode: 0o700 });
        await writeFile(join(directory, file.path), Buffer.from(file.content, 'base64'), { mode: file.executable ? 0o700 : 0o600 });
      }
      const summary = capabilities.summary.skills;
      catalog.push({ name: skill.name, description: summary.mode === 'selected' ? summary.items.find((item) => item.name === skill.name)!.description : '', instructions: join(directory, 'SKILL.md') });
    }
    context = `# Selected skills\nNative skills and slash commands are disabled for this execution. The following catalog lists the selected skills. When a skill applies, read its instructions file, then referenced resources as needed. Resolve relative resource paths from that skill directory.\n${JSON.stringify(catalog, null, 2)}`;
  }
  if (capabilities?.mcpServers !== undefined) {
    const path = join(root, 'mcp.json');
    await writeFile(path, JSON.stringify({ mcpServers: capabilities.mcpServers }), { mode: 0o600 });
    args.push('--strict-mcp-config', '--mcp-config', path);
  }
  await writeFile(join(root, 'capabilities.json'), JSON.stringify(capabilities?.summary ?? inheritedCapabilities), { mode: 0o600 });
  return { args, context };
}
