// The Evaluate pages hold a posting the server would refuse a new evaluation of: a cancelled evaluation still stopping,
// or another report-gated mode evaluating it (R31-feat-c-X-01).
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@shared/api';
import { activeEvaluationIn } from '@web/features/today/evaluate';

const session = (id: string, status: string, url: string, extra: { stopping?: true; mode?: string } = {}): SessionMeta => ({
  id, claudeSessionId: '33333333-3333-4333-8333-333333333333', mode: extra.mode ?? 'oferta', policyClass: 'evaluate', target: { type: 'url', value: url }, model: null, status, createdAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-10T10:00:00.000Z',
  turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null, error: null, reportNum: 150, lastReason: null, policyVersion: 2, ...(extra.stopping ? { stopping: true } : {}),
} as SessionMeta);

describe('activeEvaluationIn', () => {
  it('given a cancelled evaluation the server reports as still stopping, then its posting counts as being evaluated', () => {
    const list = [session('s-stop', 'cancelled', 'https://jobs.example.com/busy', { stopping: true }), session('s-end', 'cancelled', 'https://jobs.example.com/free')];
    expect(activeEvaluationIn(list, 'https://jobs.example.com/busy')?.id).toBe('s-stop');
    expect(activeEvaluationIn(list, 'https://jobs.example.com/free')).toBeUndefined();
  });

  it('given another report-gated mode evaluating the posting, then the posting counts as being evaluated', () => {
    const list = [session('s-auto', 'running', 'https://jobs.example.com/a', { mode: 'auto-pipeline' }), session('s-de', 'running', 'https://jobs.example.com/b', { mode: 'de/angebot' }), session('s-deep', 'running', 'https://jobs.example.com/c', { mode: 'deep' })];
    expect(activeEvaluationIn(list, 'https://jobs.example.com/a')?.id).toBe('s-auto');
    expect(activeEvaluationIn(list, 'https://jobs.example.com/b')?.id).toBe('s-de');
    expect(activeEvaluationIn(list, 'https://jobs.example.com/c')).toBeUndefined();
  });
});
