import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePipeline, useTracker } from '../../lib/queries';
import { apiSend } from '../../lib/api';
import { describeError } from '../../lib/actions';
import { pipelineAddBatches } from '@shared/pipeline-add';
import { SessionPanel } from '../../components/SessionPanel';
import { useRememberedSession } from '../../lib/useRememberedSession';
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

/**
 * The rule POST /api/pipeline/add checks every URL by (postingUrl in server/domains/inboxSkip.ts): one URL it refuses
 * fails the whole body, so such an offer is never sent.
 */
function addableUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > 2048 || /[\0\r\n]/.test(s)) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname) && !u.username && !u.password;
}

/** Spec 1a: ai-search session with offer envelopes, dedup against known URLs, add one or all. */
export function AiSearchTab() {
  // The search is paid and its offers can be added only here: leaving the tab or the page and coming back re-attaches
  // the last search, whose replayed offer envelopes rebuild the table.
  const remembered = useRememberedSession('cc.discover.ai');
  // New search lets go of the finished one (it stays on the Sessions page) and remounts the panel on its start form.
  const [fresh, setFresh] = useState(0);
  const pipeline = usePipeline();
  const tracker = useTracker();
  const qc = useQueryClient();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [sent, setSent] = useState<Map<string, Sent>>(new Map());
  const [note, setNote] = useState<string | null>(null);
  // A fresh panel on its start form, without the results of the search it let go of.
  const reset = useCallback(() => {
    setFresh((n) => n + 1);
    setOffers([]);
    setSent(new Map());
    setNote(null);
  }, []);
  // A search deleted elsewhere while this panel shows it: the start form comes back, and its results go with it.
  const rememberStatus = remembered.panel.onStatus;
  const onStatus = useCallback(
    (s: string) => {
      rememberStatus(s);
      if (s === 'gone') reset();
    },
    [rememberStatus, reset],
  );
  const newSearch = () => {
    // Letting go is what a deleted session gets: the store forgets it and no session is attached.
    remembered.panel.onStatus('gone');
    reset();
  };
  const known = new Set<string>([...(pipeline.data?.kind === 'ok' ? pipeline.data.rows.map((r) => r.url) : []), ...(tracker.data?.kind === 'ok' ? tracker.data.rows.map((r) => r.url ?? '') : [])]);
  const onEnvelope = useCallback((kind: string, payload: unknown) => {
    if (kind === 'offer') setOffers((prev) => (prev.some((o) => o.url === (payload as Offer).url) ? prev : [...prev, payload as Offer]));
  }, []);
  // One add at a time: a second click before the first answers would send the same offers and relabel them.
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const add = async (list: Offer[]) => {
    const fresh = list.filter((o) => addableUrl(o.url) && !known.has(o.url) && !sent.has(o.url));
    if (fresh.length === 0 || addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
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
    try {
      await qc.invalidateQueries({ queryKey: ['pipeline'] });
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  };
  const newOnes = offers.filter((o) => addableUrl(o.url) && !known.has(o.url) && !sent.has(o.url));
  return (
    <div className="stack">
      {remembered.shown && !remembered.busy && (
        <div className="row gap">
          <button type="button" onClick={newSearch}>
            New search
          </button>
        </div>
      )}
      <SessionPanel key={`${remembered.panelKey}-${fresh}`} {...remembered.panel} onStatus={onStatus} mode="ai-search" title="AI search" placeholder="Describe the role you want (seniority, stack, location, visa needs)" onEnvelope={onEnvelope} startLabel="Search" />
      {offers.length > 0 && (
        <div className="card">
          <div className="row gap" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Found {offers.length}</h2>
            <button type="button" disabled={newOnes.length === 0 || adding} onClick={() => void add(newOnes)}>
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
                  // What this page sent decides first: once added, the refetched pipeline lists the URL too.
                  const done = sent.get(o.url);
                  const dup = done === undefined && known.has(o.url);
                  const refused = done === undefined && !dup && !addableUrl(o.url);
                  return (
                    <tr key={o.url}>
                      <td>{o.company}</td>
                      <td>
                        <a href={o.url} target="_blank" rel="noreferrer noopener">
                          {o.title}
                        </a>
                      </td>
                      <td className="muted">{o.location ?? ''}</td>
                      <td>{dup ? <Pill>already known</Pill> : refused ? <Pill tone="warn">not a posting URL</Pill> : done === 'added' ? <Pill tone="ok">added</Pill> : done ? <Pill>{done}</Pill> : <Pill tone="accent">new</Pill>}</td>
                      <td>
                        <button type="button" disabled={dup || refused || done !== undefined || adding} onClick={() => void add([o])}>
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
