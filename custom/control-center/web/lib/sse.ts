import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** Server domains map to the query keys that go stale when they change. */
export const DOMAIN_KEYS: Record<string, string[][]> = {
  tracker: [['tracker'], ['insights'], ['followups']],
  reports: [['tracker'], ['insights']],
  pipeline: [['pipeline']],
  shortlist: [['shortlist']],
  immigration: [['immigration']],
  followups: [['followups'], ['tracker']],
  config: [['config'], ['system']],
  runs: [['runs']],
  sessions: [['sessions']],
};

export function useLiveInvalidation(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource('/api/events');
    const onChanged = (ev: MessageEvent) => {
      try {
        const { domain } = JSON.parse(ev.data) as { domain: string };
        for (const key of DOMAIN_KEYS[domain] ?? []) void qc.invalidateQueries({ queryKey: key });
      } catch {
        /* a malformed frame invalidates nothing */
      }
    };
    es.addEventListener('data.changed', onChanged);
    return () => es.close();
  }, [qc]);
}
