import { useState } from 'react';
import { useConfirm } from '../../components/ConfirmDialog';
import { Message } from '../../components/ActionBar';
import { Pill } from '../../components/ui';
import { fanOut } from '../../lib/sessions';
import { describeError } from '../../lib/actions';
import { BATCH_MAX_URLS } from '@shared/fanout';
import { fanoutOutcome } from '../../lib/fanoutOutcome';

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
  const start = async () => {
    if (list.length === 0 || tooMany) return;
    const n = list.length;
    if (!(await confirm({ title: `Start ${n} evaluation session${n === 1 ? '' : 's'}?`, body: 'Each URL is evaluated in its own session under the Claude slot cap (Settings > AI engine). Each one uses tokens.', confirmLabel: 'Start them', focusCancel: true }))) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await fanOut('oferta', list);
      const outcome = fanoutOutcome(r);
      // Only the URLs that did not start stay in the box, so a retry does not evaluate a started one twice.
      setUrls(outcome.failedUrls.join('\n'));
      setMessage({ tone: outcome.failedUrls.length > 0 ? 'danger' : 'ok', text: outcome.text });
      // The page moves to Sessions on onStarted, which would hide a failure and the URLs kept for the retry.
      if (outcome.failedUrls.length === 0) onStarted?.();
    } catch (err) {
      setMessage({ tone: 'danger', text: `Could not start the evaluations: ${describeError(err)}` });
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
        <button type="button" disabled={busy || list.length === 0 || tooMany} onClick={() => void start()}>
          Batch evaluate <Pill tone="warn">Uses tokens</Pill>
        </button>
        <span className={tooMany ? 'danger-text' : 'faint'}>
          {list.length} URLs{tooMany ? `; at most ${BATCH_MAX_URLS} URLs per batch` : ''}
        </span>
      </div>
      <Message message={message} />
    </div>
  );
}
