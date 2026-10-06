import { useState } from 'react';
import { DataState, Empty, Pill, Tabs } from '../../components/ui';
import { ActionButton, ActionOutput, Message } from '../../components/ActionBar';
import { useActions, useRunAction } from '../../lib/actions';
import { isPlainObject } from '../../lib/yamlOpsClient';
import { useGuardedTab } from '../../lib/unsaved';
import { KeyEditor, type FieldRules } from './StructuredEditor';
import { EditorNoteView, useStructuredConfig } from './useStructuredConfig';
import { ConfigEditor } from './RawConfigEditor';

interface SectionDef {
  key: string;
  help: string;
  empty: unknown;
  columns?: string[];
}

export const PORTAL_SECTIONS: SectionDef[] = [
  { key: 'title_filter', help: 'Role title keywords: positive (a title must match one) and negative (a match rejects the title).', empty: { positive: [], negative: [] } },
  { key: 'location_filter', help: 'Location tiers (allow, always_allow, block, block_hard) and the strict switch.', empty: { strict: false, allow: [] } },
  { key: 'tracked_companies', help: 'Companies scanned on every run. Each needs a careers_url (or an api URL); the scanner picks the provider from it unless provider names one. Toggle enabled to pause one without losing it.', empty: [], columns: ['name', 'careers_url', 'api', 'provider', 'enabled'] },
  { key: 'job_boards', help: 'Job boards and aggregators.', empty: [], columns: ['name', 'careers_url', 'api', 'provider', 'enabled'] },
  { key: 'search_queries', help: 'Free-text queries for boards that support search.', empty: [], columns: ['name', 'query', 'enabled'] },
  { key: 'visa_filter', help: 'Sponsorship signals used to rank or drop postings.', empty: {} },
  { key: 'max_posting_age_days', help: 'Postings older than this are skipped.', empty: 30 },
  { key: 'scan_history', help: 'Scan history options.', empty: {} },
  { key: 'interamt_searches', help: 'Interamt (German public sector) searches.', empty: [], columns: ['was'] },
];

const LOCATION_TIERS = ['allow', 'always_allow', 'block', 'block_hard'];

export const PORTAL_RULES: FieldRules = {
  'tracked_companies.*.name': (v) => (v.trim() ? null : 'name is required'),
  max_posting_age_days: (v) => (Number(v) > 0 && Number.isInteger(Number(v)) ? null : 'whole number of days'),
};

const filled = (v: unknown) => typeof v === 'string' && v.trim() !== '';

/**
 * Why the scanner would pass over an enabled tracked company, or null. Providers find a board from careers_url or api;
 * the other ways in are an explicit provider, a local parser command, or a websearch entry handed to the agent with
 * its query. Anything else is skipped as "no provider matched".
 */
export function trackedCompanyProblem(row: Record<string, unknown>): string | null {
  if (row.enabled === false) return null;
  if (filled(row.careers_url) || filled(row.api) || filled(row.provider)) return null;
  if (isPlainObject(row.parser) && filled(row.parser.command)) return null;
  if (row.scan_method === 'websearch' && (filled(row.scan_query) || filled(row.search_query))) return null;
  const name = filled(row.name) ? String(row.name) : 'A company';
  return `${name}: needs a careers_url or an api URL (or a provider, a parser, or scan_method websearch with a scan_query), or the scanner skips it. Add one or set enabled to false.`;
}

/** Every enabled tracked company in the document the scanner could not reach. */
export function portalsProblems(doc: unknown): string[] {
  const list = isPlainObject(doc) && Array.isArray(doc.tracked_companies) ? doc.tracked_companies : [];
  return list.flatMap((row) => (isPlainObject(row) ? [trackedCompanyProblem(row)] : [])).filter((p): p is string => p !== null);
}

function StructuredPortals() {
  const s = useStructuredConfig('portals');
  const doc = isPlainObject(s.doc) ? s.doc : {};
  const known = new Set(PORTAL_SECTIONS.map((x) => x.key));
  const unknown = Object.keys(doc).filter((k) => !known.has(k));
  const problems = portalsProblems(doc);
  return (
    <div className="stack">
      <div className="toolbar" aria-label="Portals editor actions">
        <span className="muted small">
          {s.pending.length} pending change{s.pending.length === 1 ? '' : 's'}
          {s.server?.kind === 'missing' && (
            <>
              {' '}
              <Pill tone="warn">portals.yml not created yet</Pill>
            </>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="button--ghost" onClick={s.discard} disabled={s.pending.length === 0 && !s.conflict}>
          Discard changes
        </button>
        <button type="button" className="button--primary" onClick={() => void s.save()} disabled={s.pending.length === 0 || s.saving || problems.length > 0}>
          Validate and save
        </button>
      </div>
      <EditorNoteView note={s.note} />
      {problems.length > 0 && (
        <div className="card card--warn" role="alert">
          <strong>Not saved until fixed.</strong>
          <ul className="bullets">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {s.conflict && (
        <details className="card card--warn" open>
          <summary>Current version on disk (your pending edits are applied on top in the form)</summary>
          <pre tabIndex={0} className="log mono small">{s.conflict.raw}</pre>
        </details>
      )}
      {s.q.isPending || s.q.isError ? (
        <DataState query={s.q} />
      ) : (
        <>
        {s.server?.parseError && !s.conflict && (
          <div className="card card--warn" role="alert">
            <strong>File malformed.</strong> <span className="muted">{s.server.parseError}</span> Fix it in the Raw YAML tab.
          </div>
        )}
        {PORTAL_SECTIONS.map((sec) => (
          <section key={sec.key} className="card" aria-labelledby={`portals-${sec.key}`}>
            <h3 id={`portals-${sec.key}`} className="mono">
              {sec.key}
            </h3>
            <p className="muted small">{sec.help}</p>
            {doc[sec.key] === undefined ? (
              <button type="button" onClick={() => s.addOp({ op: 'set', path: [sec.key], value: sec.empty })}>
                Add {sec.key}
              </button>
            ) : (
              <KeyEditor path={[sec.key]} value={doc[sec.key]} onOp={s.addOp} rules={PORTAL_RULES} columnsHint={sec.columns} rowRule={sec.key === 'tracked_companies' ? trackedCompanyProblem : undefined} />
            )}
            {sec.key === 'location_filter' && isPlainObject(doc.location_filter) && (
              <div className="row gap" style={{ marginTop: 8 }}>
                {LOCATION_TIERS.filter((t) => (doc.location_filter as Record<string, unknown>)[t] === undefined).map((t) => (
                  <button key={t} type="button" className="button--ghost" onClick={() => s.addOp({ op: 'set', path: ['location_filter', t], value: [] })}>
                    Add {t} tier
                  </button>
                ))}
                {(doc.location_filter as Record<string, unknown>).strict === undefined && (
                  <button type="button" className="button--ghost" onClick={() => s.addOp({ op: 'set', path: ['location_filter', 'strict'], value: false })}>
                    Add strict switch
                  </button>
                )}
              </div>
            )}
          </section>
        ))}
        <section className="card" aria-labelledby="portals-unknown">
          <h3 id="portals-unknown">Other keys</h3>
          {unknown.length === 0 ? <Empty>No keys outside the known set. Anything you add in the Raw YAML tab is kept as is.</Empty> : (
            <>
              <p className="muted small">These keys are kept verbatim; edit them in the Raw YAML tab.</p>
              <pre tabIndex={0} className="log mono small">{JSON.stringify(Object.fromEntries(unknown.map((k) => [k, doc[k]])), null, 2)}</pre>
            </>
          )}
        </section>
        </>
      )}
    </div>
  );
}

function PortalsHealth() {
  const actions = useActions();
  const { run, message, busy, output } = useRunAction();
  return (
    <div className="card">
      <h2>Portal health</h2>
      <p className="muted small">Validate is free and instant. Verify and audit hit the ATS endpoints. Fix slugs runs as a dry run first; apply it from the second button.</p>
      <div className="row gap" style={{ flexWrap: 'wrap' }}>
        {['portals.validate', 'portals.verify', 'portals.audit'].map((id) => (
          <ActionButton key={id} meta={actions.data?.find((a) => a.id === id)} disabled={busy !== null} params={id === 'portals.audit' ? { smallThreshold: 3 } : {}} onRun={(p) => void run(id, p)} />
        ))}
        <ActionButton meta={actions.data?.find((a) => a.id === 'portals.fixSlugs')} disabled={busy !== null} params={{ apply: false }} onRun={(p, o) => void run('portals.fixSlugs', p, undefined, o)}>
          Fix slugs (dry run)
        </ActionButton>
        <ActionButton meta={actions.data?.find((a) => a.id === 'portals.fixSlugs')} disabled={busy !== null} params={{ apply: true }} onRun={(p, o) => void run('portals.fixSlugs', p, undefined, o)}>
          Fix slugs (apply)
        </ActionButton>
      </div>
      <Message message={message} />
      <ActionOutput text={output} />
    </div>
  );
}

export function PortalsTab() {
  const [sub, setSub] = useState<'structured' | 'raw' | 'health'>('structured');
  const switchTo = useGuardedTab(setSub);
  return (
    <div className="stack">
      <Tabs label="Portals views" tabs={[{ id: 'structured', label: 'Structured' }, { id: 'raw', label: 'Raw YAML' }, { id: 'health', label: 'Health' }]} value={sub} onChange={switchTo} />
      {sub === 'structured' && <StructuredPortals />}
      {sub === 'raw' && <ConfigEditor fileKey="portals" label="portals.yml" validator="validate-portals.mjs" />}
      {sub === 'health' && <PortalsHealth />}
    </div>
  );
}
