import { useId, useState, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { describeError } from '../lib/actions';

export function Pill({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent'; title?: string }) {
  return (
    <span className={`chip chip--${tone}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  Evaluated: 'status-evaluated',
  Applied: 'status-applied',
  Responded: 'status-responded',
  Interview: 'status-interview',
  Offer: 'status-offer',
  Hired: 'status-hired',
  Rejected: 'status-rejected',
  Discarded: 'status-discarded',
  SKIP: 'status-skip',
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill ${STATUS_TONE[status] ?? 'status-evaluated'}`}>{status || 'unknown'}</span>;
}

export function scoreTone(score: number | null): 'ok' | 'accent' | 'warn' | 'danger' | 'neutral' {
  if (score === null) return 'neutral';
  if (score >= 4.5) return 'ok';
  if (score >= 4) return 'accent';
  if (score >= 3) return 'warn';
  return 'danger';
}

export function ScorePill({ score }: { score: number | null }) {
  return (
    <Pill tone={scoreTone(score)} title={score === null ? 'No score recorded' : `${score} out of 5`}>
      {score === null ? 'no score' : `${score.toFixed(1)}/5`}
    </Pill>
  );
}

/** A DOL tier, or a company check's verdict (sponsoring | paused | stopped | restricted | unclear, the sponsorship check template). */
/** A shortlist score: the rank plus the sponsorship adjustment, so it can pass 5 or go below 0; no "/5" scale. */
export function ShortlistScore({ score }: { score: number | null }) {
  return (
    <Pill tone={scoreTone(score)} title={score === null ? 'No score recorded' : `Shortlist score ${score}: the rank plus the sponsorship adjustment`}>
      {score === null ? 'no score' : score.toFixed(1)}
    </Pill>
  );
}

export function sponsorTone(tier: string | null | undefined): 'ok' | 'info' | 'neutral' | 'warn' | 'danger' {
  switch ((tier ?? '').toLowerCase()) {
    case 'strong':
    case 'sponsoring':
      return 'ok';
    case 'moderate':
      return 'info';
    case 'weak':
    case 'unclear':
      return 'warn';
    case 'none':
    case 'staffing-shop':
    case 'paused':
    case 'stopped':
    case 'restricted':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function SponsorPill({ tier }: { tier: string | null | undefined }) {
  return <Pill tone={sponsorTone(tier)}>{tier ? `sponsor: ${tier}` : 'sponsor: unknown'}</Pill>;
}

export function alertTone(status: string): 'danger' | 'ok' | 'neutral' {
  if (/paused|stopped|restricted/i.test(status)) return 'danger';
  if (/resumed|expanded/i.test(status)) return 'ok';
  return 'neutral';
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: string; count?: number }>; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" type="button" aria-selected={t.id === value} className={`tab ${t.id === value ? 'tab--active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="tab__count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Why a read failed, in the server's words (its error and detail), not just the HTTP status line. */
function loadError(err: unknown): string {
  const detail = (err as { body?: { detail?: unknown } } | null)?.body?.detail;
  return `${describeError(err)}${typeof detail === 'string' && detail.trim() ? `: ${detail.trim()}` : ''}`;
}

/** Loading, error, missing-file and malformed-file states, kept distinct on purpose. */
/** `emptyState` replaces the generic missing-file card when an absent file is the normal first-run state. */
/** `editable`: the children are the way to create the file, so a missing file renders them like an empty one. */
export function DataState({ query, missing, emptyState, editable, children }: { query: UseQueryResult<unknown>; missing?: ReactNode; emptyState?: ReactNode; editable?: boolean; children?: ReactNode }) {
  if (query.isPending) {
    return (
      <div className="card skeleton" aria-busy="true">
        <div className="skeleton__line" />
        <div className="skeleton__line" />
        <div className="skeleton__line short" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="card card--danger" role="alert">
        <strong>Could not load.</strong> <span className="muted">{loadError(query.error)}</span>
        <div style={{ marginTop: 8 }}>
          <button type="button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  const data = query.data as { kind?: string; path?: string; error?: string } | undefined;
  if (data?.kind === 'missing' && emptyState) return <>{emptyState}</>;
  if (data?.kind === 'missing' && editable) return <>{children}</>;
  if (data?.kind === 'missing') {
    return (
      <div className="card">
        <strong>File missing.</strong> <span className="muted mono">{data.path}</span>
        {missing && <div style={{ marginTop: 8 }}>{missing}</div>}
      </div>
    );
  }
  if (data?.kind === 'malformed') {
    return (
      <div className="card card--warn" role="alert">
        <strong>File malformed.</strong> <span className="muted">{data.error}</span> <span className="mono faint">{data.path}</span>
      </div>
    );
  }
  return <>{children}</>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted empty">{children}</p>;
}

export function Bar({ label, value, max, tone = 'accent' }: { label: string; value: number; max: number; tone?: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="bar" role="img" aria-label={`${label}: ${value}`}>
      <span className="bar__label">{label}</span>
      <span className="bar__track">
        <span className={`bar__fill bar__fill--${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="bar__value mono">{value}</span>
    </div>
  );
}

/** A table that scrolls sideways inside its own box; focusable so keyboard users can scroll it. */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={label}>
      {children}
    </div>
  );
}

/** A file input behind a button styled like the app's buttons, with the chosen file's name beside it. */
export function FilePicker({ label, accept, onFile, buttonText = 'Choose file' }: { label: string; accept: string; onFile: (file: File) => void; buttonText?: string }) {
  const [name, setName] = useState<string | null>(null);
  const nameId = useId();
  return (
    <label className="file-picker">
      <input
        type="file"
        className="sr-only"
        aria-label={label}
        aria-describedby={nameId}
        accept={accept}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so choosing the same file again still fires change.
          e.target.value = '';
          if (!file) return;
          setName(file.name);
          onFile(file);
        }}
      />
      <span className="file-picker__button" aria-hidden="true">
        {buttonText}
      </span>
      <span className="file-picker__name" id={nameId}>
        {name ?? 'No file chosen'}
      </span>
    </label>
  );
}
