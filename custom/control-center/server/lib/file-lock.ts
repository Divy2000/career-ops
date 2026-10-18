// The one lock for a read-check-write of a user-layer file: core pipeline-lock.mjs, a mkdir lock beside the file
// with the holder's pid. A process-local queue misses the other server child of a blue/green handover, which is
// alive at the same time and saves the same files; this lock is seen by both, and by the CLI scripts that take it.
import { importCore } from '../core/adapter.js';

type PipelineLock = { withPipelineLock: <T>(p: string, fn: () => T | Promise<T>, o?: { timeoutMs?: number; retryMs?: number }) => Promise<T> };

/** Runs fn holding the lock on `file`; throws LockTimeoutError (see isLockTimeout) when another holder keeps it past timeoutMs. */
export async function withFileLock<T>(codeRoot: string, file: string, fn: () => T | Promise<T>, opts: { timeoutMs: number; retryMs?: number }): Promise<T> {
  const { withPipelineLock } = await importCore<PipelineLock>(codeRoot, 'pipeline-lock.mjs');
  return withPipelineLock(file, fn, { retryMs: 50, ...opts });
}

export function isLockTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'LockTimeoutError';
}
