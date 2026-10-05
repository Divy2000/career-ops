// Runs the whole vitest suite with a fresh TMPDIR and fails the run if any test leaves something there.
import os from 'node:os';
import { startTmpGuard } from './helpers/tmp-guard.js';

export default function setup(): () => void {
  const guard = startTmpGuard(process.env, os.tmpdir());
  return guard.finish;
}
