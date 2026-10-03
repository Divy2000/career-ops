import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { apiGet } from '../../lib/api';
import type { UsageResponse } from '@shared/api';

export const useUsage = () => useQuery({ queryKey: ['system', 'usage'], queryFn: () => apiGet<UsageResponse>('/api/usage'), refetchInterval: 60_000 });

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function Meter({ label, tokens, budget }: { label: string; tokens: number; budget: number | null }) {
  const pct = budget ? Math.min(100, Math.round((tokens / budget) * 100)) : null;
  return (
    <div className="meter" role="group" aria-label={`${label} usage`}>
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <span className="muted small">{label}</span>
        <span className="mono small">
          {fmtTokens(tokens)}
          {budget ? ` / ${fmtTokens(budget)}` : ''}
        </span>
      </div>
      {pct !== null && (
        <div className="meter__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${label} budget used`}>
          <div className={`meter__fill ${pct >= 90 ? 'meter__fill--danger' : pct >= 70 ? 'meter__fill--warn' : ''}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** Read-only token meter from ~/.claude/projects (input + output + cache creation). */
export function UsageMeter({ compact = false }: { compact?: boolean }) {
  const q = useUsage();
  if (q.isPending) return <div className="usage usage--compact faint small" aria-busy="true">Reading usage</div>;
  if (q.isError) return <div className="usage faint small">Usage unavailable</div>;
  const u = q.data;
  if (u.kind === 'missing') {
    return (
      <div className={`usage ${compact ? 'usage--compact' : ''}`}>
        <span className="faint small">No Claude Code logs at {u.dir}</span>
      </div>
    );
  }
  return (
    <div className={`usage ${compact ? 'usage--compact' : ''}`} aria-label="Claude token usage">
      {!compact && <h3>Token usage</h3>}
      <Meter label="Last 5h" tokens={u.fiveHour.tokens} budget={u.budgets.fiveHourTokens} />
      <Meter label="Last 7d" tokens={u.sevenDay.tokens} budget={u.budgets.sevenDayTokens} />
      {compact ? (
        <Link to="/settings" search={{ tab: 'engine' }} className="faint small">
          Usage details
        </Link>
      ) : (
        <p className="faint small">
          {u.files} log file(s) scanned, computed {u.computedAt.slice(11, 19)} UTC. Input {fmtTokens(u.sevenDay.input)}, output {fmtTokens(u.sevenDay.output)}, cache creation {fmtTokens(u.sevenDay.cacheCreation)} over 7 days. Cache reads are not billed as new tokens and are excluded.
        </p>
      )}
    </div>
  );
}
