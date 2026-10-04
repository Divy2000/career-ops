import { useId, useState, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';

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

export function sponsorTone(tier: string | null | undefined): 'ok' | 'info' | 'neutral' | 'warn' | 'danger' {
  switch ((tier ?? '').toLowerCase()) {
    case 'strong':
      return 'ok';
    case 'moderate':
      return 'info';
    case 'weak':
      return 'warn';
    case 'none':
    case 'staffing-shop':
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

/** Loading, error, missing-file and malformed-file states, kept distinct on purpose. */
/** `emptyState` replaces the generic missing-file card when an absent file is the normal first-run state. */
export function DataState({ query, missing, emptyState, children }: { query: UseQueryResult<unknown>; missing?: ReactNode; emptyState?: ReactNode; children?: ReactNode }) {
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
        <strong>Could not load.</strong> <span className="muted">{String((query.error as Error).message)}</span>
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
