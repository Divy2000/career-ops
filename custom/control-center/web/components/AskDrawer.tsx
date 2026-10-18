import { useConfirm } from './ConfirmDialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { SessionPanel } from './SessionPanel';
import { Pill } from './ui';
import { apiGet, apiSend } from '../lib/api';
import { describeError } from '../lib/actions';
import { fanOut, startSession, startTailoredCvSession } from '../lib/sessions';
import { lastSession } from '../lib/lastSession';
import { afterFocusSettles } from '../lib/focus';
import { ASK_ACTION_SPECS, type AskActionName, type AskActionSpec } from '@shared/ask-actions';
import { fanoutOutcome } from '../lib/fanoutOutcome';
import { BATCH_MAX_URLS, FANOUT_CONFIRM_ABOVE } from '@shared/fanout';
import { localJdPath } from '@shared/local-jd';
import { dedupUrlKey } from '@shared/dedup-url';
import { plainPostingUrl, postingUrl } from '@shared/posting-url';
import { unescapeMarkdownCell } from '@shared/markdown-cell';
import { STATUS_NOTE_MAX } from '@shared/tracker-status';
import { activeEvaluationIn, evaluationStarting, useActiveEvaluation, useStartEvaluation } from '../features/today/evaluate';
import { endBatchStarting, markBatchStarting } from '../features/pipeline/InboxAi';
import { isProcessInboxMode } from '../features/pipeline/evaluating';
import { useTracker } from '../lib/queries';
import { STATES, rowIdentity } from '../features/tracker/StatusControl';
import type { PipelineRead, SessionMeta } from '@shared/api';

export interface Proposal {
  id: number;
  action: string;
  params: Record<string, unknown>;
  state: 'pending' | 'running' | 'done' | 'rejected' | 'failed' | 'unsupported';
  note: string | null;
}

/** The tracker row a proposal names (row, or the older n), trimmed: blank when it names none. */
const rowParam = (p: Record<string, unknown>): string => String(p.row ?? p.n ?? '').trim();

/** The tracker row a proposal names, or a plain note that it names none. */
const rowOf = (p: Record<string, unknown>): string => {
  const n = rowParam(p);
  return n ? `row #${n}` : '(no row given)';
};

const LABELS: Record<AskActionName, (p: Record<string, unknown>) => string> = {
  navigate: (p) => `Open ${String(p.to ?? '(no path)')}`,
  filterPipeline: (p) => `Filter the pipeline by "${String(p.q ?? p.query ?? '')}"`,
  evaluate: (p) => `Evaluate ${String(p.url ?? '')} (uses tokens)`,
  evaluateCompany: (p) => `Evaluate every pending Inbox posting at ${String(p.company ?? '')} (uses tokens)`,
  explore: () => 'Open Discover (network scan)',
  research: (p) => `Research ${String(p.topic ?? p.company ?? '')} (uses tokens)`,
  generatePdf: (p) => `Generate the tailored CV PDF for ${rowOf(p)} (uses tokens)`,
  setStatus: (p) => `Set ${rowOf(p)} to ${String(p.state ?? '')}${p.note ? ` with note "${String(p.note)}"` : ''}`,
  apply: (p) => `Open Apply for ${rowOf(p)}`,
  setApplyField: (p) => `Set the apply field ${String(p.id ?? '')}`,
  remember: (p) => `Remember: ${String(p.fact ?? '')}`,
  setProfile: () => 'Change profile.yml',
  setPortals: () => 'Change portals.yml',
};

/** The note an action the drawer does not run (`runs: false`) is answered with: what to do by hand instead. */
const BY_HAND: Partial<Record<AskActionName, string>> = {
  setApplyField: 'Edit the field directly in the Apply form.',
  setProfile: 'Structured settings editors are not available yet; edit the file from Settings when they land.',
  setPortals: 'Structured settings editors are not available yet; edit the file from Settings when they land.',
};

/** Advisor action allowlist (alpha parity), built from the list the advisor's contract is written from. `confirm` gates everything that writes. */
export const ASK_ACTIONS: Record<string, { label: (p: Record<string, unknown>) => string; confirm: boolean; writes: boolean; runs: boolean; byHand: string }> = Object.fromEntries(
  ASK_ACTION_SPECS.map((a) => [a.name, { label: LABELS[a.name], confirm: a.confirm, writes: a.writes, runs: a.runs, byHand: BY_HAND[a.name] ?? 'The drawer does not run this action; do it by hand.' }]),
);

/** Own keys only: an advisor-named action like `toString` must not reach Object.prototype. */
function askAction(name: string): (typeof ASK_ACTIONS)[string] | null {
  return Object.hasOwn(ASK_ACTIONS, name) ? ASK_ACTIONS[name]! : null;
}

/**
 * The company's pending Inbox postings, one evaluation each by URL as Evaluate visible does: only a URL-targeted evaluation
 * moves its row to Processed once the report is written, so a company-targeted session left them all pending. Like
 * Evaluate visible it leaves out saved-JD rows (`local:jds/`, evaluated through Evaluate JD) and rows flagged as needing a JD.
 * The advisor may name the company as pipeline.md writes it (`Acme \[Labs\]`) or as the Inbox shows it (`Acme [Labs]`).
 */
async function pendingUrlsAt(company: string): Promise<{ urls: string[]; leftOut: string | null }> {
  const pipeline = await apiGet<PipelineRead>('/api/pipeline');
  const names = new Set([company.toLowerCase(), unescapeMarkdownCell(company).toLowerCase()]);
  const evaluable = (pipeline.kind === 'ok' ? pipeline.rows : []).filter((r) => !r.done && !r.needsJd && localJdPath(r.url) === null && names.has(r.company.trim().toLowerCase()));
  // One URL per posting, as the fan-out counts them: a second spelling (a tracking param) would be refused as its twin.
  const byKey = new Map<string, string>();
  for (const r of evaluable) if (plainPostingUrl(r.url) && !byKey.has(dedupUrlKey(r.url))) byKey.set(dedupUrlKey(r.url), r.url);
  // The fan-out refuses a whole body over one URL that is not a plain posting address, so such a row is left out and
  // counted, unless a plain spelling of the same posting is evaluated.
  const unsendable = evaluable.filter((r) => !plainPostingUrl(r.url) && !byKey.has(dedupUrlKey(r.url))).length;
  const leftOut = unsendable === 0 ? null : `${unsendable === 1 ? '1 row has a URL that is not a plain http(s) posting address (credentials, spaces or another scheme) and is left out.' : `${unsendable} rows have a URL that is not a plain http(s) posting address (credentials, spaces or another scheme) and are left out.`} Fix it in data/pipeline.md.`;
  const urls = [...byKey.values()];
  if (urls.length === 0) throw new Error(leftOut ? `No pending Inbox posting at ${company} can be evaluated. ${leftOut}` : `No pending Inbox posting at ${company}.`);
  if (urls.length > BATCH_MAX_URLS) throw new Error(`${urls.length} pending postings at ${company}: at most ${BATCH_MAX_URLS} evaluations start at a time. Use the Inbox filter and Evaluate visible.`);
  return { urls, leftOut };
}

/** Whether a posting is a pending Inbox row, which a running Process inbox session is evaluating. */
async function isPendingInboxRow(url: string): Promise<boolean> {
  const pipeline = await apiGet<PipelineRead>('/api/pipeline');
  const key = dedupUrlKey(url);
  return pipeline.kind === 'ok' && pipeline.rows.some((r) => !r.done && dedupUrlKey(r.url) === key);
}

const allBeingEvaluated = (company: string, leftOut: string | null) =>
  leftOut ? `Every other pending Inbox posting at ${company} is already being evaluated. ${leftOut}` : `Every pending Inbox posting at ${company} is already being evaluated.`;
const PROCESS_INBOX_RUNNING = 'Process inbox is evaluating the pending rows: an evaluation started now would evaluate, report and bill them a second time. Try again once it ends.';

export function useAskHotkey(toggle: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
}

// Older keys the run switch still reads in place of a param's name (row or n, topic or company, q or query).
const PARAM_ALIASES: Record<string, string> = { row: 'n', topic: 'company', q: 'query' };

/** Statuses that still own their row or posting: a second paid session for the same target must not start. */
const LIVE = new Set(['queued', 'running', 'awaiting_user']);

/**
 * Why a proposal's params cannot run, or null: every param the advisor's contract marks required must be there, not
 * blank, and a row is a tracker row number. A navigate stays in the app (`//host` or `/\\host` would leave it) and an
 * evaluate takes a posting URL.
 */
function invalidParams(p: { action: string; params: Record<string, unknown> }): string | null {
  const spec = (ASK_ACTION_SPECS as readonly AskActionSpec[]).find((a) => a.name === p.action);
  for (const param of spec?.params ?? []) {
    const alias = PARAM_ALIASES[param.name];
    const value = p.params[param.name] ?? (alias ? p.params[alias] : undefined);
    const missing = value === undefined || value === null || String(value).trim() === '';
    if (param.required && missing) return `${p.action} needs "${param.name}", ${param.about}`;
    // A row the tracker cannot have (abc, 1.5, 0) would only fail after the user confirmed it.
    if (param.name === 'row' && !missing && !/^[1-9]\d*$/.test(String(value).trim())) return `${p.action} needs "row", ${param.about}`;
    // tracker.setStatus's schema takes only the exact canonical spelling (applied, "Applied " or Ghosted are refused).
    if (p.action === 'setStatus' && param.name === 'state' && !missing && !(STATES as readonly unknown[]).includes(value)) return `setStatus needs "state", ${param.about}`;
  }
  if (p.action === 'navigate' && (!String(p.params.to).trim().startsWith('/') || /^\/[/\\]/.test(String(p.params.to).trim()))) return `navigate needs "to", an app path such as /tracker/12`;
  // The shared posting URL rule, as Evaluate company applies it: a URL with credentials would reach the session's prompt.
  // That rule lets a space through (URL encodes it), so one word-separated URL cannot carry free text into the prompt.
  if (p.action === 'evaluate' && !plainPostingUrl(postingUrl(p.params.url))) return 'evaluate needs "url", a plain http(s) job posting URL (no credentials, at most 2048 characters)';
  // The /api/memory route refuses a fact over 300 characters, so a longer one fails before the user approves it.
  if (p.action === 'remember' && String(p.params.fact ?? '').length > 300) return 'remember needs "fact", at most 300 characters';
  // tracker.setStatus's schema refuses a note over STATUS_NOTE_MAX characters, the same way.
  if (p.action === 'setStatus' && String(p.params.note ?? '').length > STATUS_NOTE_MAX) return `setStatus takes a "note" of at most ${STATUS_NOTE_MAX} characters`;
  return null;
}

export function AskDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const confirm = useConfirm();
  // The oferta guard the Evaluate entry points share: an active session for a posting is opened, and a start is deduped.
  const activeFor = useActiveEvaluation();
  const startEvaluation = useStartEvaluation();
  // The tracker names a row by company and role in the setStatus confirm, whose note can re-link reports.
  const tracker = useTracker();
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open) return afterFocusSettles(() => drawerRef.current?.focus());
  }, [open]);
  const onEnvelope = useCallback((kind: string, payload: unknown) => {
    if (kind !== 'act') return;
    const p = payload as { action: string; params: Record<string, unknown> };
    setProposals((prev) => [...prev, { id: Date.now() + prev.length, action: p.action, params: p.params ?? {}, state: askAction(p.action) ? 'pending' : 'unsupported', note: askAction(p.action) ? null : `"${p.action}" is not in the action allowlist` }]);
  }, []);

  const update = (id: number, patch: Partial<Proposal>) => setProposals((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  /**
   * Whether a running Process inbox session already evaluates what an evaluate or evaluateCompany would: every pending
   * row, so a second evaluation would run, report and bill it twice. Read fresh, not from the 5 s poll, since Process
   * inbox can start in the gap (or while the confirm is open). A start the Inbox sent that is in no list yet counts too,
   * as Batch evaluate counts it: one still awaiting its answer, or one that reported an id other than knownProcess (the
   * id remembered when the proposal was run) that the list does not show yet.
   */
  const processInboxOwns = async (p: Proposal, knownProcess: string | null): Promise<boolean> => {
    if (p.action !== 'evaluate' && p.action !== 'evaluateCompany') return false;
    // Its own request: the shared query would join a poll sent before the run started, or be cancelled by a start.
    const list = await apiGet<SessionMeta[]>('/api/sessions');
    const process = lastSession('cc.pipeline.process');
    const remembered = process.read();
    const unlisted = remembered !== null && remembered !== knownProcess && !list.some((s) => s.id === remembered);
    if (!process.starting() && !unlisted && !list.some((s) => isProcessInboxMode(s.mode) && LIVE.has(s.status))) return false;
    return p.action === 'evaluateCompany' || (await isPendingInboxRow(String(p.params.url).trim()));
  };

  // The hidden button lags the click by a render, and confirms queue: a second click before it would ask twice.
  const started = useRef(new Set<number>());
  const run = async (p: Proposal) => {
    const def = askAction(p.action);
    if (!def || started.current.has(p.id)) return;
    started.current.add(p.id);
    const knownProcess = lastSession('cc.pipeline.process').read();
    // Running from the click on, so its button is gone: a second run would start a second paid session or write twice.
    update(p.id, { state: 'running', note: null });
    if (!def.runs) {
      update(p.id, { state: 'unsupported', note: def.byHand });
      return;
    }
    // Checked before the question: a proposal that cannot run is not offered to the user as a write to approve.
    const invalid = invalidParams(p);
    if (invalid) {
      update(p.id, { state: 'failed', note: invalid });
      return;
    }
    // A company's evaluations are counted before the question, so it says how many paid sessions it starts.
    const company = String(p.params.company ?? '').trim();
    let companyUrls: string[] = [];
    let companyLeftOut: string | null = null;
    try {
      if (await processInboxOwns(p, knownProcess)) {
        update(p.id, { state: 'failed', note: PROCESS_INBOX_RUNNING });
        return;
      }
    } catch (err) {
      update(p.id, { state: 'failed', note: describeError(err) });
      return;
    }
    if (p.action === 'evaluateCompany') {
      try {
        const pending = await pendingUrlsAt(company);
        companyLeftOut = pending.leftOut;
        companyUrls = pending.urls.filter((u) => !activeFor(u) && !evaluationStarting(u));
        if (companyUrls.length === 0) {
          update(p.id, { state: 'failed', note: allBeingEvaluated(company, companyLeftOut) });
          return;
        }
      } catch (err) {
        update(p.id, { state: 'failed', note: describeError(err) });
        return;
      }
    }
    // A row named by number only is easy to confuse with another application: the setStatus and generatePdf confirms
    // name it by company and role (setStatus also shows the note it appends to the Notes cell, which can re-link reports),
    // and the write names that application, so one a reindex moved under the number is refused.
    const rowNum = Number(rowParam(p.params));
    const shownRow = (p.action === 'setStatus' || p.action === 'generatePdf') && Number.isInteger(rowNum) && tracker.data?.kind === 'ok' ? tracker.data.rows.find((r) => r.num === rowNum) : undefined;
    const nameRow = (): string => (shownRow ? `row #${rowNum} (${shownRow.company}${shownRow.role ? ` - ${shownRow.role}` : ''})` : `row #${rowParam(p.params)}`);
    const question =
      p.action === 'evaluateCompany' && companyUrls.length > FANOUT_CONFIRM_ABOVE
        ? { title: `Start ${companyUrls.length} evaluation sessions?`, body: `The advisor proposes evaluating the ${companyUrls.length} pending Inbox postings at ${company}. They run in parallel under the Claude slot cap. Each one uses tokens.${companyLeftOut ? ` ${companyLeftOut}` : ''}`, confirmLabel: 'Start them', focusCancel: true }
        : p.action === 'evaluateCompany'
          ? { title: 'The advisor proposes a write', body: `Evaluate the ${companyUrls.length} pending Inbox ${companyUrls.length === 1 ? 'posting' : 'postings'} at ${company} (uses tokens).${companyLeftOut ? ` ${companyLeftOut}` : ''} Continue?`, confirmLabel: 'Do it', danger: true }
          : p.action === 'setStatus'
            ? { title: 'The advisor proposes a write', body: `Set ${nameRow()} to ${String(p.params.state ?? '')}${p.params.note ? `, writing the note "${String(p.params.note)}" into its Notes cell` : ''}. Continue?`, confirmLabel: 'Do it', danger: true }
            : p.action === 'generatePdf'
              ? { title: 'The advisor proposes a write', body: `Generate the tailored CV PDF for ${nameRow()} (uses tokens). Continue?`, confirmLabel: 'Do it', danger: true }
              : { title: 'The advisor proposes a write', body: `${def.label(p.params)}. Continue?`, confirmLabel: 'Do it', danger: true };
    if (def.confirm && !(await confirm(question))) {
      update(p.id, { state: 'rejected', note: 'declined' });
      return;
    }
    // Counted like a Batch fan-out from before the recheck until the started sessions are listed, so a Process inbox
    // cannot start in between and evaluate these rows too. An evaluate holds it only for a pending Inbox row.
    let holding = false;
    const hold = () => {
      holding = true;
      markBatchStarting(true);
    };
    const letGo = async () => {
      if (!holding) return;
      holding = false;
      await endBatchStarting(qc);
    };
    if (p.action === 'evaluateCompany') hold();
    try {
      // An unreadable Inbox holds too: the row may be pending.
      if (p.action === 'evaluate' && (await isPendingInboxRow(String(p.params.url).trim()).catch(() => true))) hold();
      if (await processInboxOwns(p, knownProcess)) {
        update(p.id, { state: 'failed', note: PROCESS_INBOX_RUNNING });
        return;
      }
      switch (p.action) {
        case 'navigate': {
          await router.navigate({ to: String(p.params.to).trim() as '/' });
          break;
        }
        case 'filterPipeline': {
          const q = String(p.params.q ?? p.params.query ?? '').trim();
          await router.navigate({ to: '/pipeline', search: { tab: 'inbox', ...(q ? { q } : {}) } });
          break;
        }
        case 'explore':
          await router.navigate({ to: '/discover', search: { tab: 'network' } });
          break;
        case 'apply':
          await router.navigate({ to: '/apply/$n', params: { n: rowParam(p.params) } });
          break;
        case 'evaluate': {
          const url = String(p.params.url).trim();
          // A posting still being evaluated opens that session rather than a second paid one, as Evaluate visible does.
          // Read fresh, not from the 5 s poll: it may have started elsewhere while the confirm was open.
          const active = activeEvaluationIn(await apiGet<SessionMeta[]>('/api/sessions'), url);
          if (active) {
            await router.navigate({ to: '/sessions/$id', params: { id: active.id } });
            break;
          }
          const start = startEvaluation(url);
          // Held until the start answers, however long: a slow start can still create the session, and Process inbox
          // started meanwhile would evaluate the row too. A Batch fan-out holds the same way.
          await start.catch(() => undefined);
          await letGo();
          const m = await start;
          if (m.status === 'error') {
            update(p.id, { state: 'failed', note: m.error ?? 'session failed to start' });
            return;
          }
          await router.navigate({ to: '/sessions/$id', params: { id: m.id } });
          break;
        }
        case 'evaluateCompany': {
          let outcome: ReturnType<typeof fanoutOutcome>;
          try {
            // Checked again, fresh rather than from the 5 s poll: a posting may have started evaluating elsewhere while the
            // confirm was open, and neither the sessions route nor the manager dedupes oferta sessions by target. A start
            // still awaiting its answer is in no list: one pending before the read, or still pending after it, counts.
            const startingBefore = new Set(companyUrls.filter(evaluationStarting));
            const list = await apiGet<SessionMeta[]>('/api/sessions');
            companyUrls = companyUrls.filter((u) => !startingBefore.has(u) && !evaluationStarting(u) && !activeEvaluationIn(list, u));
            if (companyUrls.length === 0) {
              update(p.id, { state: 'failed', note: allBeingEvaluated(company, companyLeftOut) });
              return;
            }
            outcome = fanoutOutcome(await fanOut('oferta', companyUrls));
          } finally {
            await letGo();
          }
          // A posting that did not start stays pending in the Inbox; the note names it, and the page stays to say why.
          if (outcome.failedUrls.length > 0) {
            update(p.id, { state: 'failed', note: `${outcome.text}. Not started: ${outcome.failedUrls.join(', ')}${companyLeftOut ? ` ${companyLeftOut}` : ''}` });
            return;
          }
          await router.navigate({ to: '/sessions' });
          if (companyLeftOut) {
            update(p.id, { state: 'done', note: companyLeftOut });
            return;
          }
          break;
        }
        case 'research': {
          const m = await startSession({ mode: 'deep', target: { type: 'text', value: String(p.params.topic ?? p.params.company ?? '') }, prompt: `Research: ${String(p.params.topic ?? p.params.company ?? '')}` });
          if (m.status === 'error') {
            update(p.id, { state: 'failed', note: m.error ?? 'session failed to start' });
            return;
          }
          await router.navigate({ to: '/sessions/$id', params: { id: m.id } });
          break;
        }
        case 'generatePdf': {
          const n = rowParam(p.params);
          // The Apply page's per-row guard (cc.pdf.N): a live pdf session for the row is opened, not doubled. Read fresh,
          // not from the 5 s poll: Apply's own start never enters the cached list, and the confirm may have been open a while.
          // An unreadable list still starts: the server refuses a second tailored CV session for the row with a 409 that names it.
          const list = await apiGet<SessionMeta[]>('/api/sessions').catch(() => [] as SessionMeta[]);
          // Read as the server reads a row: " 12" and "012" are row 12, "12.0" is not.
          const live = list.find((s) => s.mode === 'pdf' && LIVE.has(s.status) && s.target.type === 'app' && /^\s*\d+\s*$/.test(s.target.value ?? '') && Number(s.target.value) === Number(n));
          if (live) {
            await router.navigate({ to: '/sessions/$id', params: { id: live.id } });
            break;
          }
          const store = lastSession(`cc.pdf.${n}`);
          if (store.starting()) {
            update(p.id, { state: 'failed', note: `A tailored CV session for row #${n} is already starting.` });
            return;
          }
          store.setStarting(true);
          try {
            const m = await startTailoredCvSession(n, shownRow ? rowIdentity(shownRow) : undefined);
            if (m.status === 'error') {
              store.setStarting(false);
              update(p.id, { state: 'failed', note: m.error ?? 'session failed to start' });
              return;
            }
            store.write(m.id);
            store.setStarting(false);
            // The new session goes into the sessions list at once, so a second generatePdf for the same row inside the
            // poll window opens this one instead of starting a second paid session (as startEvaluation does).
            await qc.cancelQueries({ queryKey: ['sessions'], exact: true });
            qc.setQueryData<SessionMeta[]>(['sessions'], (prev) => [m, ...(prev ?? []).filter((s) => s.id !== m.id)]);
            await router.navigate({ to: '/sessions/$id', params: { id: m.id } });
          } catch (err) {
            store.setStarting(false);
            throw err;
          }
          break;
        }
        case 'setStatus':
          // The row the confirm named: after a reindex the server refuses (409) a number now holding another application.
          await apiSend('POST', '/api/actions/tracker.setStatus', {
            params: {
              row: Number(rowParam(p.params)),
              state: String(p.params.state),
              ...(p.params.note ? { note: String(p.params.note) } : {}),
              ...(shownRow ? { expectCompany: shownRow.company, expectRole: shownRow.role, expectReport: shownRow.report } : {}),
            },
          });
          await qc.invalidateQueries({ queryKey: ['tracker'] });
          break;
        case 'remember': {
          const r = await apiSend<{ result: 'ok' | 'deduped' }>('POST', '/api/memory', { fact: String(p.params.fact ?? '') });
          if (r.result === 'deduped') {
            update(p.id, { state: 'done', note: 'Already remembered: modes/_profile.md has this line.' });
            return;
          }
          break;
        }
      }
      update(p.id, { state: 'done', note: null });
    } catch (err) {
      update(p.id, { state: 'failed', note: describeError(err) });
    } finally {
      await letGo();
    }
  };

  // Closed is hidden, not unmounted: the panel holds the advisor session and delivers its envelopes only while mounted.
  return (
    <aside ref={drawerRef} tabIndex={-1} className="drawer" role="dialog" aria-modal="false" aria-label="Ask" hidden={!open}>
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Ask</h2>
        <span className="faint small">Cmd+J toggles. Read-only advisor; every action below asks before it writes.</span>
        <button type="button" onClick={onClose} aria-label="Close Ask">
          Close
        </button>
      </div>
      <SessionPanel mode="advisor" title="Advisor" target={{ type: 'text', value: pathname }} initialPrompt={`Page: ${pathname}\n\n`} placeholder="Ask about your search, or say what to do next" onEnvelope={onEnvelope} startLabel="Ask the advisor" replyLabel="Ask again" />
      {proposals.length > 0 && (
        <div className="card">
          <h2>Proposed actions</h2>
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {proposals.map((p) => {
              const def = askAction(p.action);
              return (
                <li key={p.id} className="proposal row gap" data-proposal-state={p.state}>
                  <span style={{ flex: 1 }}>
                    {def ? def.label(p.params) : p.action} {def?.writes && def.runs && <Pill tone="warn">writes</Pill>}
                    {p.note && <span className="faint small"> {p.note}</span>}
                  </span>
                  {p.state === 'pending' ? (
                    <>
                      <button type="button" onClick={() => void run(p)}>
                        {def?.confirm && def.runs ? 'Review and run' : 'Run'}
                      </button>
                      <button type="button" onClick={() => update(p.id, { state: 'rejected', note: 'dismissed' })}>
                        Dismiss
                      </button>
                    </>
                  ) : (
                    <Pill tone={p.state === 'done' ? 'ok' : p.state === 'failed' ? 'danger' : 'neutral'}>{p.state}</Pill>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </aside>
  );
}
