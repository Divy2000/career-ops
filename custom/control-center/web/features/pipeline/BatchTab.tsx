import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
import { endBatchStarting, livePipelineId, markBatchStarting, useBatchStarting, withinSessionsReadLimit } from './InboxAi';

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
  const process = useRememberedSession('cc.pipeline.process');
  const processStore = useMemo(() => lastSession('cc.pipeline.process'), []);
  const queryClient = useQueryClient();
  // A Process inbox start that reported its id after the list was read is not in it yet: the list is read again, and
  // Batch stays off until it answers. An id the server no longer lists stops blocking once that read is done.
  const processId = process.panel.sessionId;
  const processUnlisted = processId !== null && sessions.data !== undefined && !sessions.data.some((s) => s.id === processId);
  // The id that one read answered for, so a later poll of the list does not turn Batch off again.
  const [readFor, setReadFor] = useState<string | null>(null);
  const { refetch } = sessions;
  useEffect(() => {
    if (!processUnlisted || readFor === processId) return;
    void refetch().finally(() => setReadFor(processId));
  }, [processUnlisted, processId, readFor, refetch]);
  const pipelineLive = process.waiting || livePipelineId(sessions.data) !== null;
  // Another mount's fan-out (this tab left and came back while it runs) is in no list yet either.
  const fanningOut = useBatchStarting();
  const blocked = fanningOut || pipelineLive || sessions.isPending || sessions.isError || (processUnlisted && readFor !== processId);
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
    // The Process inbox run known before the confirm: one reported only while it was open is in no list yet.
    const knownProcess = processStore.read();
    if (!(await confirm({ title: `Start ${n} evaluation session${n === 1 ? '' : 's'}?`, body: 'Each URL is evaluated in its own session under the Claude slot cap (Settings > AI engine). Each one uses tokens.', confirmLabel: 'Start them', focusCancel: true }))) return;
    setBusy(true);
    setMessage(null);
    // From here until the sessions list has the started sessions, a Process inbox on the Inbox tab waits for this one.
    markBatchStarting(true);
    try {
      await launch(knownProcess);
    } finally {
      await endBatchStarting(queryClient);
      setBusy(false);
    }
  };
  const launch = async (knownProcess: string | null) => {
    // A Process inbox can start while the confirm is open: the sessions list is read again before anything starts. It is
    // also the list from before the start, so a failure part way can tell which sessions it started.
    const read = await withinSessionsReadLimit(sessions.refetch());
    if (!read.done) {
      setMessage({ tone: 'danger', text: 'Could not check for a running Process inbox, so no evaluation was started. Try again.' });
      return;
    }
    const now = read.value;
    if (now.isError || !now.data || livePipelineId(now.data) !== null) return;
    const remembered = processStore.read();
    if (processStore.starting() || (remembered !== null && remembered !== knownProcess && !now.data.some((x) => x.id === remembered))) {
      setMessage({ tone: 'danger', text: 'A Process inbox run started meanwhile, so no evaluation was started.' });
      return;
    }
    const before = new Set(now.data.map((x) => x.id));
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
      {!pipelineLive && fanningOut && !busy && <p className="muted small">Evaluations started from Pipeline are still starting, so Batch evaluate is off until they have.</p>}
      {!pipelineLive && !fanningOut && !sessions.isError && (sessions.isPending || (processUnlisted && readFor !== processId)) && <p className="muted small">Checking for a running Process inbox.</p>}
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
