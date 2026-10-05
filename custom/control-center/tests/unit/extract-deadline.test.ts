import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { EXTRACT_DEADLINE_MS, INTAKE_EXTRACT_TIMEOUT_MS, INTAKE_PROBE_TIMEOUT_MS, WORKER_MARGIN_MS } from '../../server/domains/projects.js';

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
