import { useConfirm } from './ConfirmDialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { SessionPanel } from './SessionPanel';
import { Pill } from './ui';
import { apiGet, apiSend } from '../lib/api';
import { describeError } from '../lib/actions';
import { fanOut, startSession, startTailoredCvSession } from '../lib/sessions';
import { afterFocusSettles } from '../lib/focus';
import { ASK_ACTION_SPECS, type AskActionName } from '@shared/ask-actions';
import { BATCH_MAX_URLS, FANOUT_CONFIRM_ABOVE } from '@shared/fanout';
import type { PipelineRead } from '@shared/api';

export interface Proposal {
  id: number;
  action: string;
  params: Record<string, unknown>;
  state: 'pending' | 'running' | 'done' | 'rejected' | 'failed' | 'unsupported';
  note: string | null;
}

const LABELS: Record<AskActionName, (p: Record<string, unknown>) => string> = {
  navigate: (p) => `Open ${String(p.to ?? '(no path)')}`,
  filterPipeline: (p) => `Filter the pipeline by "${String(p.q ?? p.query ?? '')}"`,
  evaluate: (p) => `Evaluate ${String(p.url ?? '')} (uses tokens)`,
  evaluateCompany: (p) => `Evaluate every pending Inbox posting at ${String(p.company ?? '')} (uses tokens)`,
  explore: () => 'Open Discover (network scan)',
  research: (p) => `Research ${String(p.topic ?? p.company ?? '')} (uses tokens)`,
  generatePdf: (p) => `Generate the tailored CV PDF for row #${String(p.row ?? p.n ?? '')} (uses tokens)`,
  setStatus: (p) => `Set row #${String(p.row ?? '')} to ${String(p.state ?? '')}`,
  apply: (p) => `Open Apply for row #${String(p.row ?? p.n ?? '')}`,
  setApplyField: (p) => `Set the apply field ${String(p.id ?? '')}`,
  remember: (p) => `Remember: ${String(p.fact ?? '')}`,
  setProfile: () => 'Change profile.yml',
  setPortals: () => 'Change portals.yml',
};

/** Advisor action allowlist (alpha parity), built from the list the advisor's contract is written from. `confirm` gates everything that writes. */
export const ASK_ACTIONS: Record<string, { label: (p: Record<string, unknown>) => string; confirm: boolean; writes: boolean }> = Object.fromEntries(
  ASK_ACTION_SPECS.map((a) => [a.name, { label: LABELS[a.name], confirm: a.confirm, writes: a.writes }]),
);

/** Own keys only: an advisor-named action like `toString` must not reach Object.prototype. */
function askAction(name: string): (typeof ASK_ACTIONS)[string] | null {
  return Object.hasOwn(ASK_ACTIONS, name) ? ASK_ACTIONS[name]! : null;
}

/**
 * The company's pending Inbox postings, one evaluation each by URL as Evaluate visible does: only a URL-targeted evaluation
 * moves its row to Processed once the report is written, so a company-targeted session left them all pending.
 */
async function pendingUrlsAt(company: string): Promise<string[]> {
  const pipeline = await apiGet<PipelineRead>('/api/pipeline');
  const urls = [...new Set((pipeline.kind === 'ok' ? pipeline.rows : []).filter((r) => !r.done && r.company.trim().toLowerCase() === company.toLowerCase()).map((r) => r.url))];
  if (urls.length === 0) throw new Error(`No pending Inbox posting at ${company}.`);
  if (urls.length > BATCH_MAX_URLS) throw new Error(`${urls.length} pending postings at ${company}: at most ${BATCH_MAX_URLS} evaluations start at a time. Use the Inbox filter and Evaluate visible.`);
  return urls;
}

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

export function AskDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const confirm = useConfirm();
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

  const run = async (p: Proposal) => {
    const def = askAction(p.action);
    if (!def) return;
    // Running from the click on, so its button is gone: a second run would start a second paid session or write twice.
    update(p.id, { state: 'running', note: null });
    // A company's evaluations are counted before the question, so it says how many paid sessions it starts.
    const company = String(p.params.company ?? '').trim();
    let companyUrls: string[] = [];
    if (p.action === 'evaluateCompany') {
      try {
        companyUrls = await pendingUrlsAt(company);
      } catch (err) {
        update(p.id, { state: 'failed', note: describeError(err) });
        return;
      }
    }
    const question =
      p.action === 'evaluateCompany' && companyUrls.length > FANOUT_CONFIRM_ABOVE
        ? { title: `Start ${companyUrls.length} evaluation sessions?`, body: `The advisor proposes evaluating the ${companyUrls.length} pending Inbox postings at ${company}. They run in parallel under the Claude slot cap. Each one uses tokens.`, confirmLabel: 'Start them', focusCancel: true }
        : p.action === 'evaluateCompany'
          ? { title: 'The advisor proposes a write', body: `Evaluate the ${companyUrls.length} pending Inbox ${companyUrls.length === 1 ? 'posting' : 'postings'} at ${company} (uses tokens). Continue?`, confirmLabel: 'Do it', danger: true }
          : { title: 'The advisor proposes a write', body: `${def.label(p.params)}. Continue?`, confirmLabel: 'Do it', danger: true };
    if (def.confirm && !(await confirm(question))) {
      update(p.id, { state: 'rejected', note: 'declined' });
      return;
    }
    try {
      switch (p.action) {
        case 'navigate': {
          const to = typeof p.params.to === 'string' ? p.params.to.trim() : '';
          if (!to.startsWith('/')) throw new Error('navigate needs "to", an app path such as /tracker/12');
          await router.navigate({ to: to as '/' });
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
          await router.navigate({ to: '/apply/$n', params: { n: String(p.params.row ?? p.params.n ?? '') } });
          break;
        case 'evaluate': {
          const m = await startSession({ mode: 'oferta', target: { type: 'url', value: String(p.params.url) }, prompt: `Evaluate this job posting following the mode file: ${String(p.params.url)}` });
          await router.navigate({ to: '/sessions/$id', params: { id: m.id } });
          break;
        }
        case 'evaluateCompany':
          await fanOut('oferta', companyUrls);
          await router.navigate({ to: '/sessions' });
          break;
        case 'research': {
          const m = await startSession({ mode: 'research', target: { type: 'text', value: String(p.params.topic ?? p.params.company ?? '') }, prompt: `Research: ${String(p.params.topic ?? p.params.company ?? '')}` });
          await router.navigate({ to: '/sessions/$id', params: { id: m.id } });
          break;
        }
        case 'generatePdf': {
          const n = String(p.params.row ?? p.params.n ?? '');
          const m = await startTailoredCvSession(n);
          await router.navigate({ to: '/sessions/$id', params: { id: m.id } });
          break;
        }
        case 'setStatus':
          await apiSend('POST', '/api/actions/tracker.setStatus', { params: { row: Number(p.params.row), state: String(p.params.state), ...(p.params.note ? { note: String(p.params.note) } : {}) } });
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
        case 'setApplyField':
          update(p.id, { state: 'unsupported', note: 'Edit the field directly in the Apply form.' });
          return;
        case 'setProfile':
        case 'setPortals':
          update(p.id, { state: 'unsupported', note: 'Structured settings editors are not available yet; edit the file from Settings when they land.' });
          return;
      }
      update(p.id, { state: 'done', note: null });
    } catch (err) {
      update(p.id, { state: 'failed', note: describeError(err) });
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
                    {def ? def.label(p.params) : p.action} {def?.writes && <Pill tone="warn">writes</Pill>}
                    {p.note && <span className="faint small"> {p.note}</span>}
                  </span>
                  {p.state === 'pending' ? (
                    <>
                      <button type="button" onClick={() => void run(p)}>
                        {def?.confirm ? 'Review and run' : 'Run'}
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
