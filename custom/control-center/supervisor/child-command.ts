// How the supervisor starts a server child, shared with the tests that start one the same way.
//
// Node runs the child itself, with tsx's loader, never through the tsx command: that launcher puts a process of its
// own between the supervisor and the server with a separate IPC channel, so the server never sees the supervisor's
// channel close, and the launcher crashes relaying a message to a supervisor that died, leaving the server orphaned.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** tsx's loader for `node --import`: runs TypeScript on any supported Node, with or without built-in type stripping. */
export function tsxLoaderUrl(packageRoot: string): string {
  return pathToFileURL(createRequire(path.join(packageRoot, 'package.json')).resolve('tsx')).href;
}

export function serverChildCommand(packageRoot: string): { bin: string; args: string[] } {
  return { bin: process.execPath, args: ['--import', tsxLoaderUrl(packageRoot), path.join(packageRoot, 'server', 'index.ts')] };
}
