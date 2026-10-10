import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { apiGet } from '../../lib/api';
import { DataState, Empty, Pill } from '../../components/ui';
import { Md } from '../../components/Md';
import { ModeLauncher } from '../../components/ModeLauncher';
import { ScriptTab, JsonView } from '../insights/ScriptTab';
import { isPlainObject } from '../../lib/yamlOpsClient';
import type { InterviewsRead } from '@shared/api';
import { localDate } from '@shared/local-date';

/**
 * story-provenance-check.mjs counts: a pill per claim list, and lowConfidence (its diagnosis, {reason, message} or
 * null) as a note that the result is inconclusive, never as a count.
 */
export function ProvenancePills({ json }: { json: unknown }) {
  if (!isPlainObject(json)) return null;
  const { lowConfidence, ...counts } = json;
  const diagnosis = isPlainObject(lowConfidence) && typeof lowConfidence.message === 'string' ? lowConfidence.message : null;
  return (
    <>
      <div className="row gap" style={{ flexWrap: 'wrap' }}>
        {Object.entries(counts).map(([k, v]) => (
          <Pill key={k} tone={k === 'supportedByResume' || k === 'existing' ? 'ok' : k === 'derivedUnverified' ? 'warn' : k === 'userCannotConfirm' ? 'danger' : 'neutral'}>
            {k}: {Array.isArray(v) ? v.length : isPlainObject(v) ? Object.keys(v).length : String(v)}
          </Pill>
        ))}
      </div>
      {diagnosis && (
        <p role="status" className="small" style={{ margin: 0 }}>
          <Pill tone="warn">inconclusive</Pill> Low confidence: {diagnosis}
        </p>
      )}
    </>
  );
}

/** Rows in rejection-latency output that name a company become explicit "Add to blacklist" suggestions; nothing is written here. */
export function companySuggestions(json: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 4 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((x) => visit(x, depth + 1));
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.company === 'string' && o.company.trim()) out.add(o.company.trim());
    Object.values(o).forEach((x) => visit(x, depth + 1));
  };
  visit(json, 0);
  return [...out];
}

export function InterviewsPage() {
  const q = useQuery({ queryKey: ['tracker', 'interviews'], queryFn: () => apiGet<InterviewsRead>('/api/interviews') });
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Interviews</h1>
      </div>
      <ModeLauncher
        heading="Interview AI"
        modes={[
          { id: 'interview-prep', label: 'Interview prep', prompt: 'Prepare me for the next interview round: ' },
          { id: 'interview/plan', label: 'Plan', prompt: 'Plan the interview loop for: ' },
          { id: 'interview/practice', label: 'Practice (multi-turn)', prompt: 'Run a mock interview with me for: ' },
          { id: 'interview/debrief', label: 'Debrief', prompt: 'Debrief this interview with me: ' },
          { id: 'interview-redflag', label: 'Red flags', prompt: 'Review this process for red flags: ' },
        ]}
      />
      <DataState query={q}>
        {q.data && (
          <div className="stack">
            <div className="card" aria-labelledby="active-heading">
              <h2 id="active-heading">Active interviews</h2>
              {q.data.active.kind === 'missing' ? (
                <Empty>
                  No {q.data.active.path} yet. Keep your interview rounds there as a table (Company, Role, Round, Date/Time, Interviewer, Status, Notes); the follow-up and insights scripts read it.
                </Empty>
              ) : (
                <Md text={q.data.active.text} />
              )}
            </div>
            <div className="card" aria-labelledby="story-heading">
              <h2 id="story-heading">Story bank</h2>
              {q.data.storyBank.kind === 'missing' ? <Empty>No interview-prep/story-bank.md yet. Edit it from Profile & CV or let interview-prep draft it.</Empty> : <Md text={q.data.storyBank.text} />}
            </div>
            <ScriptTab script="storyProvenance" title="Story provenance (story-provenance-check.mjs)">
              {(read) => (
                <div className="stack">
                  <ProvenancePills json={read.json} />
                  <JsonView value={read.json} />
                </div>
              )}
            </ScriptTab>
            <div className="card" aria-labelledby="prep-heading">
              <h2 id="prep-heading">Prep documents</h2>
              {q.data.prepDocs.length === 0 && q.data.sessions.length === 0 ? (
                <Empty>No prep documents in interview-prep/ yet.</Empty>
              ) : (
                <ul className="bullets">
                  {[...q.data.prepDocs, ...q.data.sessions].map((d) => (
                    <li key={d.path}>
                      <span className="mono">{d.path}</span> <span className="faint small">{localDate(new Date(d.mtimeMs))}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <ScriptTab script="weeklyDigest" title="Weekly digest (weekly-digest.mjs)" />
            <ScriptTab script="processQuality" title="Process quality (process-quality.mjs)" />
            <ScriptTab script="rejectionLatency" title="Rejection latency (rejection-latency.mjs)">
              {(read) => {
                const suggestions = companySuggestions(read.json);
                return (
                  <div className="stack">
                    <p className="muted small">Suggestion only: the script never writes the blacklist. Each button opens the Blacklist editor prefilled; you confirm there.</p>
                    {suggestions.length > 0 && (
                      <ul className="bullets" aria-label="Blacklist suggestions">
                        {suggestions.map((c) => (
                          <li key={c} className="row gap">
                            <span>{c}</span>
                            <Link to="/settings" search={{ tab: 'blacklist', add: c }} className="button-link">
                              Add to blacklist
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                    <JsonView value={read.json} />
                  </div>
                );
              }}
            </ScriptTab>
          </div>
        )}
      </DataState>
    </section>
  );
}
