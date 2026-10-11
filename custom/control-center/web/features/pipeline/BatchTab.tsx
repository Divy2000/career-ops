import { useEffect, useMemo, useRef, useState } from 'react';
import { useConfirm } from '../../components/ConfirmDialog';
import { Message } from '../../components/ActionBar';
import { Pill } from '../../components/ui';
import { fanOut, useSessions } from '../../lib/sessions';
import { apiGet } from '../../lib/api';
import type { SessionMeta } from '@shared/api';
import { describeError } from '../../lib/actions';
import { BATCH_MAX_URLS } from '@shared/fanout';
import { fanoutOutcome } from '../../lib/fanoutOutcome';
import { useRememberedSession } from '../../lib/useRememberedSession';
import { lastSession } from '../../lib/lastSession';
import { livePipelineId } from './InboxAi';

// Only http(s) postings go through the URL fan-out, by the rule pipeline writes use (postingUrl in
// server/domains/inboxSkip.ts): a saved JD (local:jds/) or another scheme would start a paid session on the liveness
// and fetch path, which cannot read it, and a URL carrying credentials would put them in the session's prompt.
const postingLike = (s: string): boolean => {
  if (s.length > 2048) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
};

/** The URLs of oferta sessions the server lists now and did not list in `before`: what a fan-out that failed part way did start. */
async function startedSince(urls: string[], before: Set<string>): Promise<Set<string>> {
  const sessions = await apiGet<SessionMeta[]>('/api/sessions');
  const wanted = new Set(urls);
  return new Set(sessions.filter((s) => s.mode === 'oferta' && !before.has(s.id) && s.target.value && wanted.has(s.target.value)).map((s) => s.target.value!));
}

/**
 * Pipeline > Batch: each URL becomes one oferta evaluation in its own confined session (the fan-out reserves the
 * report numbers first). batch/batch-runner.sh is never used: its workers run outside any session guard.
 */
export function BatchTab({ onStarted }: { onStarted?: () => void }) {
  const confirm = useConfirm();
  const [urls, setUrls] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const list = [...new Set(urls.split(/\s+/).filter(Boolean))];
  const tooMany = list.length > BATCH_MAX_URLS;
  const refused = list.filter((u) => !postingLike(u));
  // Process inbox evaluates every pending row, so an evaluation of one of them beside it would evaluate, report and bill
  // it a second time: Batch is off while one is starting or live, and until the sessions list tells there is none.
  const sessions = useSessions();
  const processStarting = useRememberedSession('cc.pipeline.process').waiting;
  const processStore = useMemo(() => lastSession('cc.pipeline.process'), []);
  const pipelineLive = processStarting || livePipelineId(sessions.data) !== null;
  const blocked = pipelineLive || sessions.isPending || sessions.isError;
  // Confirms queue, so a second click while one is asking or writing would ask twice: it is ignored.
  const asking = useRef(false);
  // A start can answer after the user left the page: only a still-mounted one moves them to the session.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const start = async (...args: Parameters<typeof startAsked>) => {
    if (asking.current) return;
    asking.current = true;
    try {
      await startAsked(...args);
    } finally {
      asking.current = false;
    }
  };
  const startAsked = async () => {
    if (list.length === 0 || tooMany || refused.length > 0 || blocked) return;
    const n = list.length;
    if (!(await confirm({ title: `Start ${n} evaluation session${n === 1 ? '' : 's'}?`, body: 'Each URL is evaluated in its own session under the Claude slot cap (Settings > AI engine). Each one uses tokens.', confirmLabel: 'Start them', focusCancel: true }))) return;
    setBusy(true);
    setMessage(null);
    // A Process inbox can start while the confirm is open: the sessions list is read again before anything starts. It is
    // also the list from before the start, so a failure part way can tell which sessions it started.
    const now = await sessions.refetch();
    if (now.isError || !now.data || livePipelineId(now.data) !== null || processStore.starting()) {
      setBusy(false);
      return;
    }
    const before = new Set(now.data.map((s) => s.id));
    try {
      const r = await fanOut('oferta', list);
      const outcome = fanoutOutcome(r);
      // Only the URLs that did not start stay in the box, so a retry does not evaluate a started one twice.
      setUrls(outcome.failedUrls.join('\n'));
      setMessage({ tone: outcome.failedUrls.length > 0 ? 'danger' : 'ok', text: outcome.text });
      // The page moves to Sessions on onStarted, which would hide a failure and the URLs kept for the retry.
      if (outcome.failedUrls.length === 0 && mounted.current) onStarted?.();
    } catch (err) {
      // The fan-out starts its sessions one by one and answers an error without the ones it already started: those are
      // taken out of the box, so a retry does not evaluate them twice.
      let note: string;
      try {
        const started = await startedSince(list, before);
        if (started.size > 0) setUrls(list.filter((u) => !started.has(u)).join('\n'));
        note = started.size > 0 ? ` ${started.size} started before the failure and ${started.size === 1 ? 'was' : 'were'} taken out of the box; see Sessions.` : '';
      } catch {
        note = ' Check Sessions for any that started before retrying.';
      }
      setMessage({ tone: 'danger', text: `Could not start the evaluations: ${describeError(err)}${note ? `.${note}` : ''}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card stack">
      <h2>Batch evaluate</h2>
      <p className="muted">Each URL becomes one evaluation in its own session, under the Claude slot cap. Paste one URL per line (at most {BATCH_MAX_URLS} URLs).</p>
      <textarea aria-label="Batch URLs" rows={6} value={urls} onChange={(e) => setUrls(e.target.value)} />
      <div className="row gap">
        <button type="button" disabled={busy || blocked || list.length === 0 || tooMany || refused.length > 0} onClick={() => void start()}>
          Batch evaluate <Pill tone="warn">Uses tokens</Pill>
        </button>
        <span className={tooMany ? 'danger-text' : 'faint'}>
          {list.length} URL{list.length === 1 ? '' : 's'}{tooMany ? `; at most ${BATCH_MAX_URLS} URLs per batch` : ''}
        </span>
      </div>
      {pipelineLive && <p className="muted small">Process inbox is processing the pending rows, so Batch evaluate is off until it ends.</p>}
      {!pipelineLive && sessions.isError && <p className="danger-text small">Could not check for a running Process inbox, so Batch evaluate is off until the sessions list loads.</p>}
      {refused.length > 0 && (
        <p className="danger-text small">
          Not posting URLs: {refused.join(', ')}. Paste http(s) posting links only; a saved JD (local:jds/) is evaluated from its Inbox row with Evaluate JD.
        </p>
      )}
      <Message message={message} />
    </div>
  );
}
