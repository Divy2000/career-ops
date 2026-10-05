import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePipeline, useTracker } from '../../lib/queries';
import { apiSend } from '../../lib/api';
import { describeError } from '../../lib/actions';
import { pipelineAddBatches } from '@shared/pipeline-add';
import { SessionPanel } from '../../components/SessionPanel';
import { Pill, TableScroll } from '../../components/ui';
import { addNote } from './addNote';

interface Offer {
  url: string;
  company: string;
  title: string;
  location?: string;
  source?: string;
  postedAt?: string;
}

/** A sent offer's state from its batch's counts: the route reports totals, not which URL it skipped. */
type Sent = 'added' | 'already there' | 'in pipeline';

/** Spec 1a: ai-search session with offer envelopes, dedup against known URLs, add one or all. */
export function AiSearchTab() {
  const pipeline = usePipeline();
  const tracker = useTracker();
  const qc = useQueryClient();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [sent, setSent] = useState<Map<string, Sent>>(new Map());
  const [note, setNote] = useState<string | null>(null);
  const known = new Set<string>([...(pipeline.data?.kind === 'ok' ? pipeline.data.rows.map((r) => r.url) : []), ...(tracker.data?.kind === 'ok' ? tracker.data.rows.map((r) => r.url ?? '') : [])]);
  const onEnvelope = useCallback((kind: string, payload: unknown) => {
    if (kind === 'offer') setOffers((prev) => (prev.some((o) => o.url === (payload as Offer).url) ? prev : [...prev, payload as Offer]));
  }, []);
  const add = async (list: Offer[]) => {
    const fresh = list.filter((o) => !known.has(o.url) && !sent.has(o.url));
    if (fresh.length === 0) return;
    let added = 0;
    let skipped = 0;
    try {
      // The envelope has no length limits and the route does: long fields are shortened, big lists split.
      for (const body of pipelineAddBatches(fresh)) {
        const r = await apiSend<{ added: number; skipped: number }>('POST', '/api/pipeline/add', body);
        added += r.added;
        skipped += r.skipped;
        const state: Sent = r.skipped === 0 ? 'added' : r.added === 0 ? 'already there' : 'in pipeline';
        setSent((prev) => new Map([...prev, ...body.offers.map((o) => [o.url, state] as const)]));
      }
      setNote(addNote(added, skipped));
    } catch (err) {
      setNote(`${added ? `Added ${added}, then could not add the rest` : 'Could not add'}: ${describeError(err)}`);
    }
    await qc.invalidateQueries({ queryKey: ['pipeline'] });
  };
  const newOnes = offers.filter((o) => !known.has(o.url) && !sent.has(o.url));
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
          <TableScroll label="AI search results">
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
                  const done = sent.get(o.url);
                  return (
                    <tr key={o.url}>
                      <td>{o.company}</td>
                      <td>
                        <a href={o.url} target="_blank" rel="noreferrer noopener">
                          {o.title}
                        </a>
                      </td>
                      <td className="muted">{o.location ?? ''}</td>
                      <td>{dup ? <Pill>already known</Pill> : done === 'added' ? <Pill tone="ok">added</Pill> : done ? <Pill>{done}</Pill> : <Pill tone="accent">new</Pill>}</td>
                      <td>
                        <button type="button" disabled={dup || done !== undefined} onClick={() => void add([o])}>
                          Add
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
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
