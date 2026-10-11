import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assertApprovedClaude } from '../../server/claude/cli-version.js';
import { tempDir } from '../helpers/tmp.js';

describe('Claude CLI version gate environment', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('given server internals and exported credentials, `claude --version` sees none of them', async () => {
    vi.stubEnv('CC_TOKEN', 'leak-token');
    vi.stubEnv('CC_SESSION_SECRET', 'leak-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'leak-api-key');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'leak-oauth');
    const dir = tempDir('cc-cliver-env-');
    const bin = path.join(dir, 'claude');
    const dump = path.join(dir, 'env.json');
    fs.writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));\nconsole.log('2.1.289 (Claude Code)');\n`, { mode: 0o755 });

    await expect(assertApprovedClaude(bin, 'production', { approved: ['2.1.289'] })).resolves.toBe('2.1.289');

    const seen = JSON.parse(fs.readFileSync(dump, 'utf8')) as Record<string, string>;
    expect(Object.keys(seen).filter((k) => k.startsWith('CC_') || k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CODE_OAUTH_TOKEN')).toEqual([]);
    expect(JSON.stringify(seen)).not.toMatch(/leak-/);
    expect(seen.DISABLE_AUTOUPDATER).toBe('1');
  });
});
