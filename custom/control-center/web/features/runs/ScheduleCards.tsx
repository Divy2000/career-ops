import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiGet, apiSend } from '../../lib/api';
import { describeError, useActions, useRunAction } from '../../lib/actions';
import { ActionButton, Message } from '../../components/ActionBar';
import { DataState, Empty, Pill } from '../../components/ui';
import type { ScheduleLogs, ScheduleState } from '@shared/api';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');

function JobCard({ job }: { job: ScheduleState }) {
  const qc = useQueryClient();
  const actions = useActions();
  const { run, message } = useRunAction();
  const [hour, setHour] = useState(String(job.hour ?? (job.kind === 'daily' ? 8 : 3)));
  const [minute, setMinute] = useState(String(job.minute ?? 0));
  const [weekday, setWeekday] = useState(String(job.weekday ?? 0));
  const [error, setError] = useState<string | null>(null);
  const put = async (enabled: boolean) => {
    setError(null);
    try {
      const body: Record<string, unknown> = { hour: Number(hour), minute: Number(minute), enabled };
      if (job.kind === 'weekly') body.weekday = Number(weekday);
      await apiSend('PUT', `/api/schedule/${job.label}`, body);
      toast.success(enabled ? `${job.title} scheduled at ${pad(Number(hour))}:${pad(Number(minute))}` : `${job.title} disabled`);
      await qc.invalidateQueries({ queryKey: ['system', 'schedule'] });
    } catch (err) {
      setError(`Could not update launchd: ${describeError(err)}`);
      toast.error('launchd update failed');
    }
  };
  return (
    <div className="card" aria-labelledby={`job-${job.kind}`}>
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <h2 id={`job-${job.kind}`} style={{ margin: 0 }}>
          {job.title}
        </h2>
        <div className="row gap">
          <Pill tone={job.plist === 'ok' ? 'neutral' : job.plist === 'missing' ? 'warn' : 'danger'}>{job.plist === 'ok' ? 'plist ok' : job.plist === 'missing' ? 'not installed' : 'plist malformed'}</Pill>
          <Pill tone={job.loaded ? 'ok' : 'warn'}>{job.loaded ? `loaded${job.state ? `: ${job.state}` : ''}` : 'not loaded'}</Pill>
          {job.disabled && <Pill tone="neutral">disabled at login</Pill>}
        </div>
      </div>
      <dl className="kv">
        <dt>Label</dt>
        <dd className="mono small">{job.label}</dd>
        <dt>Script</dt>
        <dd className="mono small">
          {job.script} {job.plist === 'ok' && !job.programArgumentsOk && <Pill tone="danger">plist points elsewhere</Pill>}
        </dd>
        <dt>Next fire</dt>
        <dd className="mono">{job.nextFire ? job.nextFire.slice(0, 16).replace('T', ' ') : 'n/a'}</dd>
        <dt>Last exit</dt>
        <dd className="mono">{job.lastExit === null ? 'never ran' : job.lastExit}</dd>
      </dl>
      {job.error && (
        <p role="alert" className="danger-text small">
          {job.error}
        </p>
      )}
      <div className="row gap" style={{ flexWrap: 'wrap' }}>
        {job.kind === 'weekly' && (
          <label>
            <span className="muted small">Weekday</span>{' '}
            <select aria-label={`${job.title} weekday`} value={weekday} onChange={(e) => setWeekday(e.target.value)}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span className="muted small">Hour</span> <input aria-label={`${job.title} hour`} type="number" min={0} max={23} value={hour} onChange={(e) => setHour(e.target.value)} style={{ width: 72 }} />
        </label>
        <label>
          <span className="muted small">Minute</span> <input aria-label={`${job.title} minute`} type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(e.target.value)} style={{ width: 72 }} />
        </label>
        <button type="button" className="button--primary" onClick={() => void put(true)}>
          {job.loaded ? 'Save time' : 'Install and enable'}
        </button>
        <button type="button" disabled={job.plist === 'missing' || (!job.loaded && job.disabled)} onClick={() => void put(false)}>
          Disable
        </button>
        {job.kind === 'daily' && <ActionButton meta={actions.data?.find((a) => a.id === 'daily.runNow')} onRun={() => void run('daily.runNow', {})} />}
      </div>
      <Message message={message} />
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

export function ScheduleCards() {
  const q = useQuery({ queryKey: ['system', 'schedule'], queryFn: () => apiGet<{ jobs: ScheduleState[]; agentsDir: string }>('/api/schedule') });
  return (
    <DataState query={q}>
      {(q.data?.jobs ?? []).map((j) => (
        <JobCard key={j.label} job={j} />
      ))}
      {q.data && <p className="faint small">Plists live in {q.data.agentsDir}. Changes go through plutil -lint, launchctl enable or disable (kept across logins), bootout and bootstrap.</p>}
    </DataState>
  );
}

type JobKey = 'immigration-watch' | 'upstream-sync';

export function LogBrowser() {
  const [job, setJob] = useState<JobKey>('immigration-watch');
  const [date, setDate] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['immigration', 'logs', job], queryFn: () => apiGet<ScheduleLogs>(`/api/schedule/logs?job=${job}`) });
  const chosen = date ?? list.data?.dates[0] ?? null;
  const one = useQuery({ queryKey: ['immigration', 'logs', job, chosen], queryFn: () => apiGet<ScheduleLogs['latest']>(`/api/schedule/logs/${chosen}?job=${job}`), enabled: Boolean(chosen) });
  return (
    <div className="card" aria-labelledby="log-browser-heading">
      <div className="row gap" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h2 id="log-browser-heading" style={{ margin: 0 }}>
          Job logs
        </h2>
        <div className="row gap">
          <select
            aria-label="Log job"
            value={job}
            onChange={(e) => {
              setJob(e.target.value as JobKey);
              setDate(null);
            }}
          >
            <option value="immigration-watch">daily (data/immigration/logs)</option>
            <option value="upstream-sync">weekly sync (data/upstream-sync)</option>
          </select>
          <select aria-label="Log date" value={chosen ?? ''} onChange={(e) => setDate(e.target.value)} disabled={!list.data?.dates.length}>
            {(list.data?.dates ?? []).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      </div>
      <DataState query={list}>
        {list.data && list.data.dates.length === 0 && <Empty>No logs yet for this job.</Empty>}
        {one.data && (
          <>
            <div className="row gap">
              <Pill tone={one.data.status === 'ok' ? 'ok' : one.data.status === 'failed' ? 'danger' : 'warn'}>{one.data.status}</Pill>
              <span className="faint small">
                {one.data.startedAt ?? ''} to {one.data.finishedAt ?? 'n/a'}
              </span>
            </div>
            <ul className="bullets small">
              {one.data.steps.map((s) => (
                <li key={`${s.time}-${s.name}`} className={s.failed ? 'danger-text' : ''}>
                  <span className="mono faint">{s.time}</span> {s.name}
                </li>
              ))}
            </ul>
            <pre tabIndex={0} className="log mono small" aria-label={`Log ${chosen}`}>
              {one.data.raw}
            </pre>
          </>
        )}
      </DataState>
    </div>
  );
}
