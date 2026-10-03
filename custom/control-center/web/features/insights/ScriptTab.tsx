import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { apiGet } from '../../lib/api';
import { isPlainObject, isScalar } from '../../lib/yamlOpsClient';
import { DataState, Empty, Pill } from '../../components/ui';
import type { InsightRead } from '@shared/api';

export const useInsight = (script: string) => useQuery({ queryKey: ['insights', 'script', script], queryFn: () => apiGet<InsightRead>(`/api/insights/${script}`) });

/** Renders script JSON generically: objects as key lists, arrays of objects as tables, scalars inline. */
export function JsonView({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value === null || value === undefined) return <span className="faint">n/a</span>;
  if (isScalar(value)) return <span className={typeof value === 'number' ? 'mono' : ''}>{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="faint">none</span>;
    if (value.every(isPlainObject)) {
      const cols = [...new Set(value.flatMap((r) => Object.keys(r).filter((k) => isScalar(r[k]))))];
      return (
        <div className="table-wrap">
          <table className="table table--compact">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.map((row, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c}>
                      <JsonView value={row[c]} depth={depth + 1} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    if (value.every(isScalar))
      return (
        <ul className="bullets">
          {value.map((v, i) => (
            <li key={i}>{String(v)}</li>
          ))}
        </ul>
      );
  }
  if (isPlainObject(value) && depth < 3) {
    return (
      <dl className="kv">
        {Object.entries(value).map(([k, v]) => (
          <div key={k} className="kv__pair">
            <dt className="mono">{k}</dt>
            <dd>
              <JsonView value={v} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <pre tabIndex={0} className="log mono small">{JSON.stringify(value, null, 2)}</pre>;
}

/** One cached insights script: run timestamp, cache state, Recompute, output (spec 2.10). */
export function ScriptTab({ script, title, children }: { script: string; title: string; children?: (read: InsightRead) => ReactNode }) {
  const qc = useQueryClient();
  const q = useInsight(script);
  const [busy, setBusy] = useState(false);
  const recompute = async () => {
    setBusy(true);
    try {
      const fresh = await apiGet<InsightRead>(`/api/insights/${script}?recompute=1`);
      qc.setQueryData(['insights', 'script', script], fresh);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" aria-labelledby={`insight-${script}`}>
      <div className="row gap" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h2 id={`insight-${script}`} style={{ margin: 0 }}>
          {title}
        </h2>
        <div className="row gap">
          {q.data && (
            <span className="faint small">
              computed {q.data.computedAt.slice(0, 19).replace('T', ' ')} {q.data.fromCache && <Pill>cached</Pill>}
            </span>
          )}
          <button type="button" onClick={() => void recompute()} disabled={busy} aria-busy={busy}>
            Recompute
          </button>
        </div>
      </div>
      <DataState query={q}>
        {q.data?.kind === 'failed' && (
          <div className="card card--danger" role="alert">
            <strong>The script exited {q.data.exit}.</strong>
            <details>
              <summary>Details</summary>
              <pre tabIndex={0} className="log mono small">{q.data.text || 'no output'}</pre>
            </details>
          </div>
        )}
        {q.data?.kind === 'ok' && (children ? children(q.data) : q.data.json !== null ? <JsonView value={q.data.json} /> : q.data.text ? <pre tabIndex={0} className="log mono small">{q.data.text}</pre> : <Empty>The script printed nothing.</Empty>)}
      </DataState>
    </div>
  );
}
