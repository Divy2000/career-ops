import fs from 'node:fs';
import path from 'node:path';
import { importCore } from '../core/adapter.js';

/**
 * The tracker path-resolver.mjs rawTrackerPath(dataRoot) names (CAREER_OPS_TRACKER first), made absolute against the
 * code root: the tracker scripts run there, so a relative CAREER_OPS_TRACKER means a file under it, not under the
 * server's own cwd. `canonical` is that path realpathed, as resolveTrackerPath() spells it (the lexical path while the
 * file does not exist yet).
 */
export async function resolveTrackerFile(codeRoot: string, dataRoot: string): Promise<{ lexical: string; canonical: string }> {
  const { rawTrackerPath } = await importCore<{ rawTrackerPath: (root: string) => string }>(codeRoot, 'path-resolver.mjs');
  const lexical = path.resolve(codeRoot, rawTrackerPath(dataRoot));
  try {
    return { lexical, canonical: fs.realpathSync(lexical) };
  } catch {
    return { lexical, canonical: lexical };
  }
}
