// Runs the whole vitest suite with a fresh TMPDIR and fails the run if any test leaves something there.
import os from 'node:os';
import { startTmpGuard } from './helpers/tmp-guard.js';
import { dropCareerOpsOverrides, dropSessionEnv } from './helpers/env.js';

export default function setup(): () => void {
  // Workers and the scripts they spawn inherit this environment: no shell override may point them at real data.
  dropCareerOpsOverrides(process.env);
  // Nor may a Claude session's own variables when Dev Chat runs the suite: a test's guard hook would write into that turn.
  dropSessionEnv(process.env);
  const guard = startTmpGuard(process.env, os.tmpdir());
  return guard.finish;
}
