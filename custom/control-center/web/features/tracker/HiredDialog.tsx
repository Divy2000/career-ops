import { useState } from 'react';
import { apiSend } from '../../lib/api';
import { describeError } from '../../lib/actions';

/** Hired Wall ask (AGENTS.md cadence): draft, not now (later) or no (never); one ask per hire. */
export function HiredDialog({ report, company, onClose }: { report: number; company: string; onClose: () => void }) {
  const [anonymity, setAnonymity] = useState<'handle' | 'role' | 'count'>('role');
  const [story, setStory] = useState('');
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (params: Record<string, unknown>, id: 'tracker.hiredShare' | 'tracker.hiredMark', close: boolean) => {
    setError(null);
    try {
      const r = await apiSend<{ result: unknown; stderr?: string }>('POST', `/api/actions/${id}`, { params });
      const text = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
      if (close) onClose();
      else setOutput(`${text}\n${r.stderr ?? ''}`.trim());
    } catch (err) {
      setError(describeError(err));
    }
  };
  const issueUrl = output?.match(/https:\/\/github\.com\/\S+/)?.[0] ?? null;
  return (
    <div className="card stack" role="dialog" aria-label="Hired celebration">
      <h2>Congratulations on {company}!</h2>
      <p className="muted">Share an anonymous story on the Hired Wall? Nothing is posted by the app: you review the prefilled GitHub issue and submit it yourself.</p>
      <label className="row gap">
        <span className="muted">Anonymity</span>
        <select aria-label="Anonymity" value={anonymity} onChange={(e) => setAnonymity(e.target.value as typeof anonymity)}>
          <option value="handle">handle</option>
          <option value="role">role only</option>
          <option value="count">count only</option>
        </select>
      </label>
      <textarea aria-label="Your story" rows={3} placeholder="What worked? (optional)" value={story} onChange={(e) => setStory(e.target.value)} />
      <div className="row gap">
        <button type="button" onClick={() => void act({ report, anonymity, ...(story ? { story } : {}) }, 'tracker.hiredShare', false)}>
          Draft story
        </button>
        <button type="button" onClick={() => void act({ report, mark: 'later' }, 'tracker.hiredMark', true)}>
          Not now
        </button>
        <button type="button" onClick={() => void act({ report, mark: 'never' }, 'tracker.hiredMark', true)}>
          No, never ask again
        </button>
      </div>
      {issueUrl && (
        <p>
          <a href={issueUrl} target="_blank" rel="noreferrer noopener">
            Open the prefilled GitHub issue
          </a>
        </p>
      )}
      {output && (
        <pre className="log" aria-label="Hired share draft" tabIndex={0}>
          {output}
        </pre>
      )}
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
