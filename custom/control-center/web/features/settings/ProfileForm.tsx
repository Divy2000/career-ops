import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiGet, apiSend, ApiError } from '../../lib/api';
import { describeError } from '../../lib/actions';
import { DataState, Empty, Pill, Tabs } from '../../components/ui';
import { isPlainObject } from '../../lib/yamlOpsClient';
import { useGuardedTab, useUnsaved } from '../../lib/unsaved';
import { useEditBase } from '../../lib/editBase';
import { KeyEditor, type ColumnsAt, type FieldRules } from './StructuredEditor';
import { EditorNoteView, useStructuredConfig } from './useStructuredConfig';
import { ConfigEditor } from './RawConfigEditor';
import type { CadenceRead } from '@shared/api';

interface SectionDef {
  key: string;
  help: string;
  empty: unknown;
}

/** Every section of config/profile.example.yml, with a skeleton for the ones not set yet. */
export const PROFILE_SECTIONS: SectionDef[] = [
  { key: 'candidate', help: 'Contact details printed on the CV and used in outreach.', empty: { full_name: '', email: '', phone: '', location: '', linkedin: '', portfolio_url: '', github: '' } },
  { key: 'target_roles', help: 'North Star roles and the archetypes the evaluation scores against.', empty: { primary: [], archetypes: [] } },
  { key: 'narrative', help: 'Headline, exit story, superpowers and proof points.', empty: { headline: '', exit_story: '', superpowers: [], proof_points: [] } },
  { key: 'compensation', help: 'Target range, currency, walk-away number and flexibility.', empty: { target_range: '', currency: 'USD', minimum: '', location_flexibility: '' } },
  // needs_sponsorship starts true: false tells evaluations a "we do not sponsor" JD is fine, and an omitted key reads as false upstream.
  { key: 'location', help: 'Where you are, where you are authorized to work and whether you need sponsorship (needs_sponsorship starts ticked; untick it if you do not).', empty: { country: '', city: '', timezone: '', visa_status: '', authorized_in: [], needs_sponsorship: true } },
  { key: 'disability', help: 'Optional quota-eligibility flag (never disclosed automatically).', empty: { br_pcd_quota_eligible: false } },
  { key: 'language', help: 'Output language and market modes directory.', empty: { output: 'en' } },
  { key: 'spend_tier', help: 'economy, standard or premium.', empty: 'standard' },
  { key: 'page_format', help: 'letter or a4 for every generated PDF.', empty: 'letter' },
  // Starts empty: every token theme-style.mjs maps overrides the template, so a seeded value would recolor every PDF.
  { key: 'style', help: 'CV and cover-letter PDF theming tokens. Add only the keys you want to change; the rest keep the built-in look.', empty: {} },
  { key: 'cv', help: 'Output format, template, section order.', empty: { output_format: 'html' } },
  { key: 'culture_screen', help: 'Required culture signals and the cap when they are absent.', empty: { require: [], deprioritize_if_absent: false } },
  { key: 'latex', help: 'Your own LaTeX CV for latex-tex mode.', empty: { source: 'resume.tex' } },
  { key: 'cover_letter', help: 'Notice period, domain and language-learning closers.', empty: { notice_period_days: 30, primary_domain: '', language_learning: [] } },
  { key: 'contact_preferences', help: 'Preferred channel for outreach drafts.', empty: { preferred_channel: 'either', note: '' } },
  { key: 'outreach', help: 'Greeting character budget.', empty: { greeting_max_chars: 150 } },
  { key: 'application_email', help: 'Application email drafting switches.', empty: { include_contact_block: true, include_attachment_checklist: true } },
  { key: 'scan', help: 'JD extractor and scan timeout.', empty: { extractor: 'mcp', timeout_seconds: 230 } },
  { key: 'auto_pdf_score_threshold', help: 'Minimum score that auto-generates a PDF.', empty: 3 },
  { key: 'pipeline', help: 'Two-pass triage gate.', empty: { triage_threshold: 3.5, triage_min_urls: 5 } },
  { key: 're_apply_windows', help: 'Cooldown windows per company.', empty: {} },
];

/** The lists of objects in config/profile.example.yml: their skeletons start empty, so the form needs their columns. */
export const PROFILE_LIST_COLUMNS: ColumnsAt = {
  'target_roles.archetypes': ['name', 'level', 'fit'],
  'narrative.proof_points': ['name', 'url', 'hero_metric'],
  'cover_letter.language_learning': ['language', 'current_level', 'target_level', 'target_date', 'sentence'],
};

export const PROFILE_RULES: FieldRules = {
  'language.output': (v) => (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(v) ? null : 'ISO language code such as en or zh-CN'),
  spend_tier: (v) => (['economy', 'standard', 'premium'].includes(v) ? null : 'economy, standard or premium'),
  page_format: (v) => (['letter', 'a4'].includes(v) ? null : 'letter or a4'),
  'candidate.email': (v) => (v === '' || v.includes('@') ? null : 'needs an @'),
  'cv.output_format': (v) => (['html', 'latex', 'text'].includes(v) ? null : 'html, latex or text'),
  'contact_preferences.preferred_channel': (v) => (['email', 'phone', 'either'].includes(v) ? null : 'email, phone or either'),
  'scan.extractor': (v) => (['mcp', 'cli'].includes(v) ? null : 'mcp or cli'),
};

const CADENCE_HELP: Record<string, string> = {
  applied_first_days: 'Days after applying before the first follow-up',
  applied_subsequent_days: 'Days between later follow-ups while Applied',
  applied_max_followups: 'Maximum follow-ups while Applied',
  responded_initial_days: 'Days after a response before nudging',
  responded_subsequent_days: 'Days between nudges while Responded',
  interview_thankyou_days: 'Days after an interview for the thank-you note',
};

/** Follow-up cadence form: PUT /api/followups/cadence writes only followup_cadence keys (comments kept) and runs validate-profile. */
export function CadenceForm() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', 'cadence'], queryFn: () => apiGet<CadenceRead>('/api/followups/cadence') });
  // Saves against the version the edit started from, so a change on disk meanwhile gets the 409, not an overwrite.
  const edit = useEditBase(q.data);
  const [draft, setDraftState] = useState<Record<string, string>>({});
  const setDraft = (next: Record<string, string>) => {
    if (Object.keys(next).length) edit.pin();
    setDraftState(next);
  };
  useUnsaved('the follow-up cadence', Object.keys(draft).length > 0);
  const [note, setNote] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const value = (k: string) => draft[k] ?? (q.data?.cadence[k] !== undefined ? String(q.data.cadence[k]) : '');
  // One save at a time: a second click would send the same ETag, get the 409 once the first lands, and report a
  // conflict for a write that happened.
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const save = async () => {
    if (inFlight.current) return;
    const cadence: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(draft)) cadence[k] = v.trim() === '' ? null : Number(v);
    if (Object.values(cadence).some((v) => v !== null && (!Number.isInteger(v) || v < 0))) {
      setNote({ tone: 'danger', text: 'Cadence values are whole numbers of days (0 or more).' });
      return;
    }
    const from = edit.base ?? q.data;
    inFlight.current = true;
    setSaving(true);
    try {
      await apiSend('PUT', '/api/followups/cadence', { cadence }, from?.etag ? { 'If-Match': from.etag } : {});
      edit.rebase(null);
      setDraftState({});
      setNote({ tone: 'ok', text: 'Follow-up cadence saved (validated by validate-profile.mjs).' });
      toast.success('Follow-up cadence saved');
      await Promise.all([qc.invalidateQueries({ queryKey: ['config'] }), qc.invalidateQueries({ queryKey: ['followups'] })]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Told, the user may now save their values over the version on disk they were shown: the next save carries
        // that version's ETag, so a further change on disk meanwhile is refused again.
        await qc.invalidateQueries({ queryKey: ['config', 'cadence'] });
        edit.rebase(qc.getQueryData<CadenceRead>(['config', 'cadence']) ?? null);
        setNote({ tone: 'danger', text: 'config/profile.yml changed on disk since you started editing; nothing was written. Your values are still in the form: save again to apply them over the current version.' });
      } else setNote({ tone: 'danger', text: `Could not save cadence: ${describeError(err)}` });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return (
    <div className="card" aria-labelledby="cadence-heading">
      <h2 id="cadence-heading">Follow-up cadence</h2>
      <p className="muted small">Used by followup-cadence.mjs. Empty removes the key so the script default applies.</p>
      <DataState query={q} editable>
        {q.data?.kind === 'missing' && <Pill tone="warn">config/profile.yml is missing; saving creates it with just these keys</Pill>}
        <div className="fields">
          {(q.data?.keys ?? Object.keys(CADENCE_HELP)).map((k) => (
            <div key={k} className="fields__row">
              <label className="fields__label" htmlFor={`cadence-${k}`}>
                <span className="mono">{k}</span>
                <span className="faint small">{CADENCE_HELP[k]}</span>
              </label>
              <div className="fields__value">
                <input id={`cadence-${k}`} type="number" min={0} max={365} value={value(k)} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
              </div>
            </div>
          ))}
        </div>
        <div className="row gap">
          <button type="button" className="button--primary" disabled={Object.keys(draft).length === 0 || saving} onClick={() => void save()}>
            Save cadence
          </button>
        </div>
        {edit.drifted && !note && (
          <p role="alert" className="danger-text">
            config/profile.yml changed on disk since you started editing. Your values are kept; Save cadence shows the conflict before anything is written.
          </p>
        )}
        {note && (
          <p role={note.tone === 'danger' ? 'alert' : 'status'} className={note.tone === 'danger' ? 'danger-text' : 'muted'}>
            {note.text}
          </p>
        )}
      </DataState>
    </div>
  );
}

function StructuredProfile() {
  const s = useStructuredConfig('profile');
  const doc = isPlainObject(s.doc) ? s.doc : {};
  const known = new Set([...PROFILE_SECTIONS.map((x) => x.key), 'followup_cadence']);
  const unknown = Object.keys(doc).filter((k) => !known.has(k));
  return (
    <div className="stack">
      <div className="toolbar" aria-label="Profile editor actions">
        <span className="muted small">
          {s.pending.length} pending change{s.pending.length === 1 ? '' : 's'}
          {s.server?.kind === 'missing' && (
            <>
              {' '}
              <Pill tone="warn">config/profile.yml not created yet</Pill>
            </>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="button--ghost" onClick={s.discard} disabled={(s.pending.length === 0 && !s.conflict) || s.saving}>
          Discard changes
        </button>
        <button type="button" className="button--primary" onClick={() => void s.save()} disabled={s.pending.length === 0 || s.saving}>
          Validate and save profile
        </button>
      </div>
      <EditorNoteView note={s.note} />
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
        {PROFILE_SECTIONS.map((sec) => (
          <section key={sec.key} className="card" aria-labelledby={`profile-${sec.key}`}>
            <h3 id={`profile-${sec.key}`} className="mono">
              {sec.key}
            </h3>
            <p className="muted small">{sec.help}</p>
            {doc[sec.key] === undefined ? (
              <button type="button" onClick={() => s.addOp({ op: 'set', path: [sec.key], value: sec.empty })}>
                Add {sec.key}
              </button>
            ) : (
              <KeyEditor path={[sec.key]} value={doc[sec.key]} onOp={s.addOp} rules={PROFILE_RULES} columnsAt={PROFILE_LIST_COLUMNS} />
            )}
          </section>
        ))}
        <section className="card" aria-labelledby="profile-unknown">
          <h3 id="profile-unknown">Other keys</h3>
          {unknown.length === 0 ? <Empty>No keys outside the documented sections.</Empty> : (
            <>
              <p className="muted small">Kept verbatim; edit them in the Raw YAML tab.</p>
              <pre tabIndex={0} className="log mono small">{JSON.stringify(Object.fromEntries(unknown.map((k) => [k, doc[k]])), null, 2)}</pre>
            </>
          )}
        </section>
        </>
      )}
    </div>
  );
}

export function ProfileTab() {
  const [sub, setSub] = useState<'form' | 'cadence' | 'raw'>('form');
  const switchTo = useGuardedTab(setSub);
  return (
    <div className="stack">
      <Tabs label="Profile views" tabs={[{ id: 'form', label: 'Form' }, { id: 'cadence', label: 'Follow-up cadence' }, { id: 'raw', label: 'Raw YAML' }]} value={sub} onChange={switchTo} />
      {sub === 'form' && <StructuredProfile />}
      {sub === 'cadence' && <CadenceForm />}
      {sub === 'raw' && <ConfigEditor fileKey="profile" label="config/profile.yml" validator="validate-profile.mjs" />}
    </div>
  );
}
