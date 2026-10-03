// Core writer modules never load into the server process: they run here, in a
// `node --input-type=module -e` child with cwd at the code root, JSON in on
// stdin and JSON out on stdout.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTRACT } from './adapter.js';

export interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function coreModuleUrl(codeRoot: string, module: string): string {
  if (!CONTRACT.writers.includes(module)) throw new Error(`${module} is not a contracted core writer module`);
  return pathToFileURL(path.join(codeRoot, module)).href;
}

export function runModule(code: string, opts: { cwd: string; env: NodeJS.ProcessEnv; input: unknown; timeoutMs: number }): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(opts.input));
  });
}

/** Parse the child's JSON stdout, surfacing stderr when it is not JSON. */
export function childJson<T>(r: ChildResult): T {
  try {
    return JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as T;
  } catch {
    throw new Error(`core child exited ${r.code} without JSON: ${(r.stderr || r.stdout).trim().slice(-600)}`);
  }
}
