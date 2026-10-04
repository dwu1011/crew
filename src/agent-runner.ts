import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request } from './client.js';

async function report(path: string, body: unknown) {
  return request(process.env.CREW_HOME!, path, body, process.env.CREW_EXECUTION_TOKEN!);
}

if (process.argv[2] === '--hook') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  await report('/executions/ready', { sessionId: event.session_id, cwd: event.cwd });
} else {
  const launch = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
    executable: string; args: string[]; env: Record<string, string>;
  };
  Object.assign(process.env, launch.env);
  delete process.env.CLAUDECODE;
  const child = spawn(launch.executable, launch.args, { stdio: 'inherit', env: process.env });
  const reason = await new Promise<string>((resolve) => {
    child.once('error', (error) => resolve(`Native runtime could not start: ${error.message}`));
    child.once('exit', (code, signal) => resolve(`Native runtime exited: ${signal ?? code}`));
  });
  console.error(reason);
  await report('/executions/exited', { reason }).catch((error: Error) => console.error(`Could not report runtime exit: ${error.message}`));
  process.exitCode = 1;
}
