import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useActiveEvaluation, useStartEvaluation } from './evaluate';
import { describeError } from '../../lib/actions';
import { Pill } from '../../components/ui';

/** Global "Evaluate URL": starts an oferta session and opens it (spec 1a), or opens the one still evaluating that URL. */
export function QuickEvaluate() {
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeFor = useActiveEvaluation();
  const startEvaluation = useStartEvaluation();
  const go = async () => {
    const u = url.trim();
    if (!/^https?:\/\//.test(u)) {
      setError('Paste a full http(s) posting URL.');
      return;
    }
    // A posting still being evaluated opens that session rather than a second paid one.
    const active = activeFor(u);
    if (active) {
      setError(null);
      await navigate({ to: '/sessions/$id', params: { id: active.id } });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const m = await startEvaluation(u);
      await navigate({ to: '/sessions/$id', params: { id: m.id } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>
        Quick evaluate <Pill tone="warn">Uses tokens</Pill>
      </h2>
      <form
        className="row gap"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <input aria-label="Posting URL to evaluate" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://jobs.example.com/..." style={{ flex: 1 }} />
        <button type="submit" disabled={busy || !url.trim()}>
          Evaluate URL
        </button>
      </form>
      {error && (
        <p role="alert" className="danger-text small">
          {error}
        </p>
      )}
    </div>
  );
}
