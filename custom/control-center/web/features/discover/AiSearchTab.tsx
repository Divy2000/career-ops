import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePipeline, useTracker } from '../../lib/queries';
import { apiSend } from '../../lib/api';
import { SessionPanel } from '../../components/SessionPanel';
import { Pill } from '../../components/ui';

interface Offer {
  url: string;
  company: string;
  title: string;
  location?: string;
  source?: string;
}

/** Spec 1a: ai-search session with offer envelopes, dedup against known URLs, add one or all. */
export function AiSearchTab() {
  const pipeline = usePipeline();
  const tracker = useTracker();
  const qc = useQueryClient();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const known = new Set<string>([...(pipeline.data?.kind === 'ok' ? pipeline.data.rows.map((r) => r.url) : []), ...(tracker.data?.kind === 'ok' ? tracker.data.rows.map((r) => r.url ?? '') : [])]);
  const onEnvelope = useCallback((kind: string, payload: unknown) => {
    if (kind === 'offer') setOffers((prev) => (prev.some((o) => o.url === (payload as Offer).url) ? prev : [...prev, payload as Offer]));
  }, []);
  const add = async (list: Offer[]) => {
    const fresh = list.filter((o) => !known.has(o.url) && !added.has(o.url));
    if (fresh.length === 0) return;
    try {
      await apiSend('POST', '/api/pipeline/add', { offers: fresh.map((o) => ({ url: o.url, company: o.company, title: o.title, location: o.location })) });
      setAdded((prev) => new Set([...prev, ...fresh.map((o) => o.url)]));
      setNote(`Added ${fresh.length} to the pipeline`);
      await qc.invalidateQueries({ queryKey: ['pipeline'] });
    } catch (err) {
      setNote(`Could not add: ${(err as Error).message}`);
    }
  };
  const newOnes = offers.filter((o) => !known.has(o.url) && !added.has(o.url));
  return (
    <div className="stack">
      <SessionPanel mode="ai-search" title="AI search" placeholder="Describe the role you want (seniority, stack, location, visa needs)" onEnvelope={onEnvelope} startLabel="Search" />
      {offers.length > 0 && (
        <div className="card">
          <div className="row gap" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Found {offers.length}</h2>
            <button type="button" disabled={newOnes.length === 0} onClick={() => void add(newOnes)}>
              Add all new ({newOnes.length})
            </button>
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  <th scope="col">Title</th>
                  <th scope="col">Location</th>
                  <th scope="col">State</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {offers.map((o) => {
                  const dup = known.has(o.url);
                  const done = added.has(o.url);
                  return (
                    <tr key={o.url}>
                      <td>{o.company}</td>
                      <td>
                        <a href={o.url} target="_blank" rel="noreferrer noopener">
                          {o.title}
                        </a>
                      </td>
                      <td className="muted">{o.location ?? ''}</td>
                      <td>{dup ? <Pill>already known</Pill> : done ? <Pill tone="ok">added</Pill> : <Pill tone="accent">new</Pill>}</td>
                      <td>
                        <button type="button" disabled={dup || done} onClick={() => void add([o])}>
                          Add
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {note && (
            <p role="status" className="muted small">
              {note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
