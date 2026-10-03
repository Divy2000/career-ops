import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useDashboard } from '../../lib/queries';
import { Bar, DataState, Empty, Tabs } from '../../components/ui';
import { EmptyTracker } from '../../components/EmptyTracker';
import { ModeLauncher } from '../../components/ModeLauncher';
import { ScriptTab } from './ScriptTab';

const route = getRouteApi('/insights');
export type InsightsTab = 'overview' | 'progress' | 'breakdown' | 'velocity' | 'patterns' | 'salary' | 'skills' | 'legitimacy' | 'ai';

const DASHBOARD_TABS: InsightsTab[] = ['overview', 'progress', 'breakdown'];

export function InsightsPage() {
  const { tab } = route.useSearch();
  const navigate = useNavigate({ from: '/insights' });
  const q = useDashboard();
  const d = q.data?.kind === 'ok' ? q.data.dashboard : null;
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Insights</h1>
      </div>
      <Tabs
        label="Insights sections"
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'progress', label: 'Progress' },
          { id: 'breakdown', label: 'Breakdown' },
          { id: 'velocity', label: 'Funnel velocity' },
          { id: 'patterns', label: 'Patterns' },
          { id: 'salary', label: 'Salary' },
          { id: 'skills', label: 'Skills' },
          { id: 'legitimacy', label: 'Reposts & legitimacy' },
          { id: 'ai', label: 'AI analyses' },
        ]}
        value={tab}
        onChange={(t: InsightsTab) => void navigate({ search: { tab: t } })}
      />
      {tab === 'ai' && (
        <ModeLauncher
          heading="AI analyses"
          modes={[
            { id: 'patterns', label: 'Patterns', prompt: 'Analyze the patterns across my evaluations and outcomes.' },
            { id: 'calibrate', label: 'Calibrate', prompt: 'Calibrate my scoring against outcomes so far.' },
            { id: 'upskill', label: 'Upskill', prompt: 'Which skills would most improve my match rate? Propose a plan.' },
            { id: 'titles', label: 'Titles', prompt: 'Which job titles should I target, given my profile and results?' },
          ]}
        />
      )}
      {tab === 'velocity' && <ScriptTab script="funnelVelocity" title="Funnel velocity (funnel-velocity.mjs)" />}
      {tab === 'patterns' && <ScriptTab script="analyzePatterns" title="Patterns (analyze-patterns.mjs)" />}
      {tab === 'salary' && <ScriptTab script="salaryGap" title="Salary gap (salary-gap.mjs)" />}
      {tab === 'skills' && (
        <div className="stack">
          <ScriptTab script="upskill" title="Upskill map (upskill.mjs)" />
          <p className="muted small">Per-posting keyword match and JD skill gap live on each application's Documents tab.</p>
        </div>
      )}
      {tab === 'legitimacy' && (
        <div className="stack">
          <ScriptTab script="detectReposts" title="Reposts (detect-reposts.mjs)" />
          <ScriptTab script="companyHistory" title="Company history (company-history.mjs)" />
        </div>
      )}
      {DASHBOARD_TABS.includes(tab) && (
        <DataState query={q} emptyState={<EmptyTracker nothingTo="measure" />}>
          {d && d.totals.applications === 0 ? (
            <EmptyTracker nothingTo="measure" />
          ) : (
            <>
          {d && tab === 'overview' && (
            <div className="stack">
              <div className="tiles">
                <div className="tile">
                  <span className="tile__label">Applications</span>
                  <span className="tile__value">{d.totals.applications}</span>
                </div>
                <div className="tile">
                  <span className="tile__label">Average score</span>
                  <span className="tile__value">{d.totals.averageScore ?? 'n/a'}</span>
                </div>
                <div className="tile">
                  <span className="tile__label">Interviews reached</span>
                  <span className="tile__value">{d.funnel.find((f) => f.stage === 'Interview')?.count ?? 0}</span>
                </div>
                <div className="tile">
                  <span className="tile__label">Offers</span>
                  <span className="tile__value">{d.funnel.find((f) => f.stage === 'Offer')?.count ?? 0}</span>
                </div>
              </div>
              <div className="card">
                <h2>By status</h2>
                {Object.entries(d.totals.byStatus).map(([s, n]) => (
                  <Bar key={s} label={s} value={n} max={d.totals.applications} />
                ))}
              </div>
              <div className="card">
                <h2>Stage transitions</h2>
                {d.stageTransitions.length === 0 ? (
                  <Empty>No transitions in status-log.tsv yet.</Empty>
                ) : (
                  d.stageTransitions.map((t) => <Bar key={`${t.from}-${t.to}`} label={`${t.from} to ${t.to}`} value={t.count} max={d.stageTransitions[0]!.count} tone="info" />)
                )}
              </div>
              <div className="card">
                <h2>Top companies</h2>
                <ul className="bullets">
                  {d.topCompanies.map((c) => (
                    <li key={c.company}>
                      <strong>{c.company}</strong> <span className="muted">{c.count} application(s), average {c.averageScore ?? 'n/a'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {d && tab === 'progress' && (
            <div className="stack">
              <div className="card">
                <h2>Funnel</h2>
                {d.funnel.map((f) => (
                  <Bar key={f.stage} label={f.stage} value={f.count} max={d.funnel[0]?.count ?? 1} />
                ))}
              </div>
              <div className="card">
                <h2>Rates</h2>
                <dl className="kv">
                  <dt>Evaluated to applied</dt>
                  <dd>{d.rates.evaluatedToApplied ?? 'n/a'}%</dd>
                  <dt>Applied to interview</dt>
                  <dd>{d.rates.appliedToInterview ?? 'n/a'}%</dd>
                  <dt>Interview to offer</dt>
                  <dd>{d.rates.interviewToOffer ?? 'n/a'}%</dd>
                </dl>
              </div>
              <div className="card">
                <h2>Score distribution</h2>
                {d.scoreBuckets.map((b) => (
                  <Bar key={b.label} label={b.label} value={b.count} max={Math.max(1, ...d.scoreBuckets.map((x) => x.count))} tone="warn" />
                ))}
              </div>
              <div className="card">
                <h2>Weekly activity</h2>
                {d.weeklyActivity.length === 0 ? <Empty>No transitions yet.</Empty> : d.weeklyActivity.map((w) => <Bar key={w.week} label={w.week} value={w.transitions} max={Math.max(...d.weeklyActivity.map((x) => x.transitions))} tone="info" />)}
              </div>
            </div>
          )}
          {d && tab === 'breakdown' && (
            <div className="stack">
              <div className="card">
                <h2>Archetypes</h2>
                {d.archetypes.map((a) => (
                  <Bar key={a.archetype} label={`${a.archetype} (avg ${a.averageScore ?? 'n/a'})`} value={a.count} max={d.totals.applications} />
                ))}
              </div>
              <div className="card">
                <h2>Work mode</h2>
                {Object.entries(d.workMode).map(([k, v]) => (
                  <Bar key={k} label={k} value={v} max={d.totals.applications} tone="info" />
                ))}
              </div>
              <div className="card">
                <h2>Score tiers</h2>
                {d.scoreBuckets.map((b) => (
                  <Bar key={b.label} label={b.label} value={b.count} max={Math.max(1, d.totals.scored)} tone="warn" />
                ))}
              </div>
            </div>
          )}
            </>
          )}
        </DataState>
      )}
    </section>
  );
}
