import { describe, expect, it } from 'vitest';
import { runModule } from '../../server/core/child.js';

describe('a core writer child', () => {
  it('that exits before reading a large stdin input resolves with its exit code and stderr instead of an unhandled EPIPE (R29-srv-core-L1-01)', async () => {
    // Fails the way a broken import graph does: gone before fs.readFileSync(0), with far more input queued than a pipe holds.
    const code = `process.stderr.write('ERR_MODULE_NOT_FOUND'); process.exit(1);`;
    const r = await runModule(code, { cwd: process.cwd(), env: {}, input: 'x'.repeat(4 * 1024 * 1024), timeoutMs: 10_000 });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('ERR_MODULE_NOT_FOUND');
  });
});
