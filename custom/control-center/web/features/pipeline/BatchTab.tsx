import { useState } from 'react';
import { useConfirm } from '../../components/ConfirmDialog';
import { Message } from '../../components/ActionBar';
import { Pill } from '../../components/ui';
import { fanOut } from '../../lib/sessions';
import { apiGet } from '../../lib/api';
import type { SessionMeta } from '@shared/api';
import { describeError } from '../../lib/actions';
import { BATCH_MAX_URLS } from '@shared/fanout';
import { fanoutOutcome } from '../../lib/fanoutOutcome';

// Only http(s) postings go through the URL fan-out: a saved JD (local:jds/) or another scheme would start a paid
// session on the liveness and fetch path, which cannot read it.
const postingLike = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const sessionIds = async (): Promise<Set<string>> => new Set((await apiGet<SessionMeta[]>('/api/sessions')).map((s) => s.id));

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
  const start = async () => {
    if (list.length === 0 || tooMany || refused.length > 0) return;
    const n = list.length;
    if (!(await confirm({ title: `Start ${n} evaluation session${n === 1 ? '' : 's'}?`, body: 'Each URL is evaluated in its own session under the Claude slot cap (Settings > AI engine). Each one uses tokens.', confirmLabel: 'Start them', focusCancel: true }))) return;
    setBusy(true);
    setMessage(null);
    // The sessions listed before the start, so a failure part way can tell which ones it started.
    const before = await sessionIds().catch(() => null);
    try {
      const r = await fanOut('oferta', list);
      const outcome = fanoutOutcome(r);
      // Only the URLs that did not start stay in the box, so a retry does not evaluate a started one twice.
      setUrls(outcome.failedUrls.join('\n'));
      setMessage({ tone: outcome.failedUrls.length > 0 ? 'danger' : 'ok', text: outcome.text });
      // The page moves to Sessions on onStarted, which would hide a failure and the URLs kept for the retry.
      if (outcome.failedUrls.length === 0) onStarted?.();
    } catch (err) {
      // The fan-out starts its sessions one by one and answers an error without the ones it already started: those are
      // taken out of the box, so a retry does not evaluate them twice.
      let note: string;
      try {
        if (!before) throw new Error('no sessions list from before the start');
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
        <button type="button" disabled={busy || list.length === 0 || tooMany || refused.length > 0} onClick={() => void start()}>
          Batch evaluate <Pill tone="warn">Uses tokens</Pill>
        </button>
        <span className={tooMany ? 'danger-text' : 'faint'}>
          {list.length} URL{list.length === 1 ? '' : 's'}{tooMany ? `; at most ${BATCH_MAX_URLS} URLs per batch` : ''}
        </span>
      </div>
      {refused.length > 0 && (
        <p className="danger-text small">
          Not posting URLs: {refused.join(', ')}. Paste http(s) posting links only; a saved JD (local:jds/) is evaluated from its Inbox row with Evaluate JD.
        </p>
      )}
      <Message message={message} />
    </div>
  );
}
