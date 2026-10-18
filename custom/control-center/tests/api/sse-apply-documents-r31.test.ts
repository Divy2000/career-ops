// The Apply page's suggested CV and cover come from the tracker row's report link and company, so a tracker change
// must make its ['apply', 'documents', n] answer stale (R31-weblib-L2-01).
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { domainFor } from '../../server/watch/watcher.js';
import { DOMAIN_KEYS } from '../../web/lib/sse.js';

/** Whether the change event for `rel` leaves a cached `key` stale, as the app stream's invalidation does. */
async function staleAfterChange(rel: string, key: unknown[]): Promise<boolean> {
  const qc = new QueryClient();
  qc.setQueryData(key, { cached: true });
  const domain = domainFor(rel);
  for (const k of domain ? (DOMAIN_KEYS[domain] ?? []) : []) await qc.invalidateQueries({ queryKey: k, refetchType: 'none' });
  return qc.getQueryState(key)?.isInvalidated ?? false;
}

describe('app stream invalidation of the Apply documents (R31-weblib-L2-01)', () => {
  it('given a cached Apply row answer, when the tracker changes, then that answer is stale', async () => {
    expect(await staleAfterChange('data/applications.md', ['apply', 'documents', 7])).toBe(true);
  });

  it('given a cached Apply row answer, when a root-level tracker changes, then that answer is stale', async () => {
    expect(await staleAfterChange('applications.md', ['apply', 'documents', 7])).toBe(true);
  });
});
