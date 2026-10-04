import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { processIdentity } from './process-identity.js';
import { request } from './client.js';

async function report(path: string, body: unknown) {
  return request(process.env.CREW_HOME!, path, body, process.env.CREW_EXECUTION_TOKEN!);
}

if (process.argv[2] === '--hook') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  const root = process.env.CREW_EXECUTION_ROOT!;
  const receipt = JSON.parse(await readFile(join(root, 'process.json'), 'utf8'));
  if (receipt.nativeSessionId !== event.session_id || receipt.cwd !== event.cwd) throw new Error('Native startup identity mismatch');
  writeFileSync(join(root, 'ready.json'), JSON.stringify({ generation: receipt.generation, sessionId: event.session_id, cwd: event.cwd }), { mode: 0o600 });
  await report('/executions/ready', { sessionId: event.session_id, cwd: event.cwd });
} else {
  const launch = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
    executable: string; args: string[]; env: Record<string, string>;
  };
  Object.assign(process.env, launch.env);
  delete process.env.CLAUDECODE;
  const child = spawn(launch.executable, launch.args, { stdio: 'inherit', env: process.env });
  const receiptPath = join(dirname(process.argv[2]), 'process.json');
  writeFileSync(`${receiptPath}.tmp`, JSON.stringify({ executionId: process.env.CREW_EXECUTION_ID,
    generation: process.env.CREW_GENERATION, nativeSessionId: launch.args[launch.args.indexOf('--session-id') + 1],
    cwd: process.cwd(), runnerPid: process.pid, runnerIdentity: processIdentity(process.pid),
    nativePid: child.pid ?? null, nativeIdentity: child.pid ? processIdentity(child.pid) : null }), { mode: 0o600 });
  renameSync(`${receiptPath}.tmp`, receiptPath);
  const reason = await new Promise<string>((resolve) => {
    child.once('error', (error) => resolve(`Native runtime could not start: ${error.message}`));
    child.once('exit', (code, signal) => resolve(`Native runtime exited: ${signal ?? code}`));
  });
  console.error(reason);
  await report('/executions/exited', { reason }).catch((error: Error) => console.error(`Could not report runtime exit: ${error.message}`));
  process.exitCode = 1;
}
