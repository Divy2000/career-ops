import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { EXTRACT_DEADLINE_MS, INTAKE_EXTRACT_TIMEOUT_MS, INTAKE_PROBE_TIMEOUT_MS, WORKER_MARGIN_MS } from '../../server/domains/projects.js';
import { isCredential } from '../../server/system/child-env.js';
import { tempDir } from '../helpers/tmp.js';

describe('the PDF extraction deadline', () => {
  it('mirrors the timeouts intake.mjs itself uses for the probe and the extraction', () => {
    const intake = fs.readFileSync(path.join(DEFAULT_CODE_ROOT, 'intake.mjs'), 'utf8');
    const ms = (re: RegExp) => Number(intake.match(re)?.[1]?.replace(/_/g, ''));
    expect(ms(/candidate\.probeArgs, \{[^}]*timeout: ([\d_]+)/)).toBe(INTAKE_PROBE_TIMEOUT_MS);
    expect(ms(/\['-layout', path, '-'\],\s*\{[^}]*timeout: ([\d_]+)/)).toBe(INTAKE_EXTRACT_TIMEOUT_MS);
  });

  it('outlasts an uncached probe plus the extraction plus worker startup, with margin', () => {
    expect(EXTRACT_DEADLINE_MS).toBe(INTAKE_PROBE_TIMEOUT_MS + INTAKE_EXTRACT_TIMEOUT_MS + WORKER_MARGIN_MS);
    expect(EXTRACT_DEADLINE_MS).toBeGreaterThanOrEqual(45_000);
  });
});

describe('the PDF extraction worker (R17-srv-dom-a-X-02, R28-srv-dom-a-X-01)', () => {
  /** Runs the worker with `env` against a stand-in intake.mjs whose extractor lists the environment its child sees. */
  async function childEnvKeys(env: Record<string, string>): Promise<Set<string>> {
    // The stand-in runs a child the way intake's pdftotext call does (execFileSync, no env).
    const dir = tempDir('cc-extract-env-');
    const intakePath = path.join(dir, 'intake.mjs');
    fs.writeFileSync(
      intakePath,
      `import { execFileSync } from 'node:child_process';
export const detectPdfExtractor = () => ({ name: 'fake', extract: () => execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], { encoding: 'utf8' }) });
`,
    );
    const workerFile = fileURLToPath(new URL('../../server/domains/extract-worker.mjs', import.meta.url));
    const worker = new Worker(workerFile, { workerData: { intakePath, abs: path.join(dir, 'x.pdf'), probed: true }, env });
    const message = await new Promise<{ ok: boolean; text?: string; error?: string }>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    await worker.terminate();
    expect(message).toMatchObject({ ok: true });
    return new Set(JSON.parse(message.text!) as string[]);
  }

  it('drops the server internals and Claude credentials childEnv drops', async () => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CC_TOKEN: 'leak-token', CC_SESSION_SECRET: 'leak-secret', ANTHROPIC_API_KEY: 'sk-leak', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-leak', CLAUDE_CODE_CUSTOM_HEADERS: 'x', ANTHROPIC_BASE_URL: 'https://proxy.example' };
    const seen = await childEnvKeys(env);
    expect(Object.keys(env).filter((k) => seen.has(k) && (k.startsWith('CC_') || isCredential(k)))).toEqual([]);
  });

  it('hands the extractor only the variables a PDF tool needs, so no other credential reaches it', async () => {
    const needed = { PATH: '/usr/bin:/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TMPDIR: '/tmp', TZ: 'UTC', CAREER_OPS_ROOT: '/data', CAREER_OPS_DATA_DIR: '/data', CAREER_OPS_DOCUMENTS_DIR: '/data/documents', CAREER_OPS_INTAKE_STATE: '/data/data/intake-state.json' };
    const secrets = { OPENAI_API_KEY: 'sk-openai', GITHUB_TOKEN: 'ghp-leak', AWS_SECRET_ACCESS_KEY: 'aws-leak', GOOGLE_APPLICATION_CREDENTIALS: '/k.json', DATABASE_URL: 'postgres://u:p@h/db', NPM_CONFIG__AUTH: 'npm-leak', CAREER_OPS_API_KEY: 'co-leak', CAREER_OPS_GITHUB_PAT: 'ghp-co-leak', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000' };
    const seen = await childEnvKeys({ ...needed, ...secrets });
    expect(Object.keys(secrets).filter((k) => seen.has(k))).toEqual([]);
    expect(Object.keys(needed).filter((k) => seen.has(k))).toEqual(Object.keys(needed));
  });
});
