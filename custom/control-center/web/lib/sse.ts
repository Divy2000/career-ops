import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** Server domains map to the query keys that go stale when they change. */
export const DOMAIN_KEYS: Record<string, string[][]> = {
  tracker: [['tracker'], ['insights'], ['followups']],
  reports: [['tracker'], ['insights']],
  pipeline: [['pipeline']],
  shortlist: [['shortlist']],
  // An application's detail carries its company sponsorship file and alert.
  immigration: [['immigration'], ['sponsorship'], ['tracker', 'row']],
  interviews: [['tracker', 'interviews'], ['insights']],
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
    // A job log's status is decided when it is read (a run killed before its done line turns interrupted), so every
    // reader refetches too: the job logs under ['immigration', 'logs'] and the Today chip's overview under ['immigration'].
    es.addEventListener('daily.status', () => {
      void qc.invalidateQueries({ queryKey: ['system', 'daily'] });
      void qc.invalidateQueries({ queryKey: ['immigration'] });
    });
    es.addEventListener('run.status', () => void qc.invalidateQueries({ queryKey: ['runs'] }));
    // The bus keeps no replay and a restarted server's watcher ignores what changed before it started, so whatever
    // changed while the stream was down sent no event: a reconnect refetches everything instead.
    let opened = false;
    es.addEventListener('open', () => {
      if (opened) void qc.invalidateQueries();
      opened = true;
    });
    return () => es.close();
  }, [qc]);
}
