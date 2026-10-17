// A cancelled evaluation whose process is still stopping keeps its posting out of a new Evaluate, as the server does
// (R28-fb-rev-01).
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@shared/api';
import { evaluatingTargets } from '@web/features/pipeline/evaluating';

const session = (id: string, status: string, url: string, extra: { stopping?: true } = {}): SessionMeta => ({
  id, claudeSessionId: '33333333-3333-4333-8333-333333333333', mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: url }, model: null, status, createdAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-10T10:00:00.000Z',
  turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null, error: null, reportNum: 150, lastReason: null, policyVersion: 2, ...extra,
} as SessionMeta);

describe('evaluatingTargets', () => {
  it('given a cancelled evaluation the server reports as still stopping, then its posting stays out of a new start', () => {
    const targets = evaluatingTargets([session('s-stop', 'cancelled', 'https://jobs.example.com/busy', { stopping: true }), session('s-end', 'cancelled', 'https://jobs.example.com/free')]);
    expect(targets.has('https://jobs.example.com/busy')).toBe(true);
    expect(targets.has('https://jobs.example.com/free')).toBe(false);
  });
});
