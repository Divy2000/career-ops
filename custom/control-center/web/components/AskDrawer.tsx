import { useConfirm } from './ConfirmDialog';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { SessionPanel } from './SessionPanel';
import { Pill } from './ui';
import { apiSend } from '../lib/api';
import { describeError } from '../lib/actions';
import { startSession } from '../lib/sessions';

export interface Proposal {
  id: number;
  action: string;
  params: Record<string, unknown>;
  state: 'pending' | 'done' | 'rejected' | 'failed' | 'unsupported';
  note: string | null;
}

/** Advisor action allowlist (alpha parity). `confirm` gates everything that writes. */
export const ASK_ACTIONS: Record<string, { label: (p: Record<string, unknown>) => string; confirm: boolean; writes: boolean }> = {
  navigate: { label: (p) => `Open ${String(p.to ?? '/')}`, confirm: false, writes: false },
  filterPipeline: { label: (p) => `Filter the pipeline by "${String(p.q ?? p.query ?? '')}"`, confirm: false, writes: false },
  evaluate: { label: (p) => `Evaluate ${String(p.url ?? '')} (uses tokens)`, confirm: true, writes: true },
  evaluateCompany: { label: (p) => `Evaluate every posting at ${String(p.company ?? '')} (uses tokens)`, confirm: true, writes: true },
  explore: { label: () => 'Open Discover (network scan)', confirm: false, writes: false },
  research: { label: (p) => `Research ${String(p.topic ?? p.company ?? '')} (uses tokens)`, confirm: true, writes: false },
  generatePdf: { label: (p) => `Generate the tailored CV PDF for row #${String(p.row ?? p.n ?? '')} (uses tokens)`, confirm: true, writes: true },
  setStatus: { label: (p) => `Set row #${String(p.row ?? '')} to ${String(p.state ?? '')}`, confirm: true, writes: true },
  apply: { label: (p) => `Open Apply for row #${String(p.row ?? p.n ?? '')}`, confirm: false, writes: false },
  setApplyField: { label: (p) => `Set the apply field ${String(p.id ?? '')}`, confirm: false, writes: false },
  remember: { label: (p) => `Remember: ${String(p.fact ?? '')}`, confirm: true, writes: true },
  setProfile: { label: () => 'Change profile.yml', confirm: true, writes: true },
  setPortals: { label: () => 'Change portals.yml', confirm: true, writes: true },
};

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
  const onEnvelope = useCallback((kind: string, payload: unknown) => {
    if (kind !== 'act') return;
    const p = payload as { action: string; params: Record<string, unknown> };
    setProposals((prev) => [...prev, { id: Date.now() + prev.length, action: p.action, params: p.params ?? {}, state: ASK_ACTIONS[p.action] ? 'pending' : 'unsupported', note: ASK_ACTIONS[p.action] ? null : `"${p.action}" is not in the action allowlist` }]);
  }, []);

  const update = (id: number, patch: Partial<Proposal>) => setProposals((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const run = async (p: Proposal) => {
    const def = ASK_ACTIONS[p.action];
    if (!def) return;
    if (def.confirm && !(await confirm({ title: 'The advisor proposes a write', body: `${def.label(p.params)}. Continue?`, confirmLabel: 'Do it', danger: true }))) {
      update(p.id, { state: 'rejected', note: 'declined' });
      return;
    }
    try {
      switch (p.action) {
        case 'navigate':
          await router.navigate({ to: String(p.params.to ?? '/') as '/' });
          break;
        case 'filterPipeline':
          await router.navigate({ to: '/pipeline', search: { tab: 'inbox' } });
          break;
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
        case 'evaluateCompany': {
          const m = await startSession({ mode: 'oferta', target: { type: 'company', value: String(p.params.company) }, prompt: `Evaluate every pending pipeline posting at ${String(p.params.company)}.` });
          await router.navigate({ to: '/sessions/$id', params: { id: m.id } });
          break;
        }
        case 'research': {
          const m = await startSession({ mode: 'research', target: { type: 'text', value: String(p.params.topic ?? p.params.company ?? '') }, prompt: `Research: ${String(p.params.topic ?? p.params.company ?? '')}` });
          await router.navigate({ to: '/sessions/$id', params: { id: m.id } });
          break;
        }
        case 'generatePdf': {
          const n = String(p.params.row ?? p.params.n ?? '');
          const m = await startSession({ mode: 'pdf', target: { type: 'app', value: n }, prompt: `Generate the tailored CV PDF for tracker row #${n}.` });
          await router.navigate({ to: '/sessions/$id', params: { id: m.id } });
          break;
        }
        case 'setStatus':
          await apiSend('POST', '/api/actions/tracker.setStatus', { params: { row: Number(p.params.row), state: String(p.params.state), ...(p.params.note ? { note: String(p.params.note) } : {}) } });
          await qc.invalidateQueries({ queryKey: ['tracker'] });
          break;
        case 'remember':
          await apiSend('POST', '/api/memory', { fact: String(p.params.fact ?? '') });
          break;
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

  if (!open) return null;
  return (
    <aside className="drawer" role="dialog" aria-modal="false" aria-label="Ask">
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
              const def = ASK_ACTIONS[p.action];
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
