import { useState } from 'react';
import { Command } from 'cmdk';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { NAV_GROUPS } from '../nav';
import { apiGet } from '../lib/api';
import { describeError, useActions, useRunAction } from '../lib/actions';
import { startSession } from '../lib/sessions';
import { targetFor } from '../features/sessions/SessionsPage';
import { useConfirm } from './ConfirmDialog';
import { ActionOutput, CostPill } from './ActionBar';
import { THEME_OPTIONS } from './ThemeSwitcher';
import { THEME_MODES, useTheme } from '../lib/theme';
import type { ActionMeta, ModePolicy } from '@shared/api';

interface JsonProp {
  type?: string | string[];
  enum?: unknown[];
  /** zod writes a union of literals (the network scan's sinceDays) as an anyOf of consts with no top-level type. */
  anyOf?: Array<{ const?: unknown; type?: string }>;
  items?: { type?: string };
  default?: unknown;
  description?: string;
}
interface JsonSchema {
  properties?: Record<string, JsonProp>;
  required?: string[];
}

/** The params the caller must fill in (a field with a default is not one). */
export function requiredParams(a: ActionMeta): string[] {
  return (a.params as JsonSchema).required ?? [];
}

/** Actions whose params are all optional with no default run straight from the palette; the rest open the params dialog. */
export function needsParamsDialog(a: ActionMeta): boolean {
  return requiredParams(a).length > 0 || Object.values((a.params as JsonSchema).properties ?? {}).some((p) => p.default !== undefined);
}

/** The fixed choices of a field (an enum, or an anyOf of consts), in their own types; null for a free field. */
export function paramOptions(p: JsonProp): unknown[] | null {
  if (p.enum) return p.enum;
  if (p.anyOf?.length && p.anyOf.every((o) => 'const' in o)) return p.anyOf.map((o) => o.const);
  return null;
}

const typeOf = (p: JsonProp): string => (Array.isArray(p.type) ? (p.type.find((t) => t !== 'null') ?? 'string') : (p.type ?? 'string'));

/** Parses the text fields of the params dialog into the shapes the action's zod schema expects. */
export function parseParamValues(schema: JsonSchema, values: Record<string, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const raw = values[key];
    const t = typeOf(prop);
    if (t === 'boolean') {
      if (typeof raw === 'boolean') out[key] = raw;
      continue;
    }
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const options = paramOptions(prop);
    if (options) out[key] = options.find((o) => String(o) === raw) ?? raw;
    else if (t === 'number' || t === 'integer') out[key] = Number(raw);
    else if (t === 'array') out[key] = raw.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => (prop.items?.type === 'number' || prop.items?.type === 'integer' ? Number(s) : s));
    else out[key] = raw;
  }
  return out;
}

function ActionParamsDialog({ action, error, onClose, onRun }: { action: ActionMeta; error?: string | null; onClose: () => void; onRun: (params: Record<string, unknown>) => Promise<void> }) {
  const schema = action.params as JsonSchema;
  const required = new Set(schema.required ?? []);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const props = Object.entries(schema.properties ?? {});
  const missing = [...required].filter((k) => {
    const v = values[k];
    return typeof v === 'string' ? v.trim() === '' : v === undefined && typeOf(schema.properties?.[k] ?? {}) !== 'boolean';
  });
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog__overlay" />
        <Dialog.Content className="dialog" aria-describedby={undefined}>
          <Dialog.Title className="dialog__title">
            {action.label} <CostPill cost={action.cost} />
          </Dialog.Title>
          {props.length === 0 && <p className="muted">This action takes no parameters.</p>}
          {props.map(([key, prop]) => {
            const t = typeOf(prop);
            const label = `${key}${required.has(key) ? ' (required)' : ''}`;
            if (t === 'boolean')
              return (
                <label key={key} className="row gap">
                  <input type="checkbox" checked={values[key] === true} onChange={(e) => setValues({ ...values, [key]: e.target.checked })} /> {label}
                </label>
              );
            const options = paramOptions(prop);
            if (options)
              return (
                <label key={key} className="stack">
                  <span className="muted small">{label}</span>
                  <select aria-label={key} value={typeof values[key] === 'string' ? (values[key] as string) : ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })}>
                    <option value="">{prop.default !== undefined ? `default (${String(prop.default)})` : 'choose'}</option>
                    {options.map((v) => (
                      <option key={String(v)} value={String(v)}>
                        {String(v)}
                      </option>
                    ))}
                  </select>
                </label>
              );
            if (t === 'array')
              return (
                <label key={key} className="stack">
                  <span className="muted small">{label}, one per line</span>
                  <textarea aria-label={key} rows={3} value={typeof values[key] === 'string' ? (values[key] as string) : ''} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
                </label>
              );
            return (
              <label key={key} className="stack">
                <span className="muted small">
                  {label} {prop.description && <span className="faint">{prop.description}</span>}
                </span>
                <input
                  aria-label={key}
                  type={t === 'number' || t === 'integer' ? 'number' : 'text'}
                  placeholder={prop.default !== undefined ? `default (${String(prop.default)})` : undefined}
                  value={typeof values[key] === 'string' ? (values[key] as string) : ''}
                  onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                />
              </label>
            );
          })}
          {error && (
            <p role="alert" className="danger-text">
              {error}
            </p>
          )}
          <div className="row gap dialog__actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="button--primary"
              disabled={busy || missing.length > 0}
              title={missing.length ? `Fill in ${missing.join(', ')}` : undefined}
              onClick={() => {
                setBusy(true);
                void onRun(parseParamValues(schema, values)).finally(() => setBusy(false));
              }}
            >
              Run
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** What a sync action printed (its result and stderr), so a palette run is never just a "Done" toast. */
function ActionOutputDialog({ label, text, onClose }: { label: string; text: string; onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog__overlay" />
        <Dialog.Content className="dialog" aria-describedby={undefined}>
          <Dialog.Title className="dialog__title">{label}: output</Dialog.Title>
          <ActionOutput text={text} />
          <div className="row gap dialog__actions">
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ModeLaunchDialog({ mode, onClose }: { mode: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Each click starts a paid session, so the button waits for the first start to answer.
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      setError(null);
      const meta = await startSession({ mode, target: targetFor(target, mode), prompt });
      // A 202 can carry a session that failed before its turn ran (no approved CLI, no token): say why and stay for a retry.
      if (meta.status === 'error') {
        setError(meta.error ?? 'session failed to start');
        return;
      }
      toast.success(`Started ${mode} session`);
      onClose();
      await navigate({ to: '/sessions/$id', params: { id: meta.id } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog__overlay" />
        <Dialog.Content className="dialog" aria-describedby={undefined}>
          <Dialog.Title className="dialog__title">Start a {mode} session</Dialog.Title>
          <label className="stack">
            <span className="muted small">Target (URL, company or row number, optional)</span>
            <input aria-label="Session target" value={target} onChange={(e) => setTarget(e.target.value)} />
          </label>
          <label className="stack">
            <span className="muted small">Prompt</span>
            <textarea aria-label="Session prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          {error && (
            <p role="alert" className="danger-text">
              {error}
            </p>
          )}
          <div className="row gap dialog__actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="button--primary" disabled={busy || !prompt.trim()} onClick={() => void start()}>
              Start (uses tokens)
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Cmd+K palette: navigation, every registry action (a params dialog when needed) and every mode launcher (spec P6). */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const actions = useActions();
  const modes = useQuery({ queryKey: ['modes'], queryFn: () => apiGet<ModePolicy[]>('/api/modes'), staleTime: 60_000, enabled: open });
  const confirm = useConfirm();
  const { run, output, message, setMessage } = useRunAction();
  const [outputOf, setOutputOf] = useState<string | null>(null);
  const { setMode } = useTheme();
  const [launch, setLaunch] = useState<string | null>(null);
  const [withParams, setWithParams] = useState<ActionMeta | null>(null);
  const go = (to: string) => {
    onOpenChange(false);
    void navigate({ to: to as '/' });
  };
  const execute = async (a: ActionMeta, params: Record<string, unknown>, fromDialog = false) => {
    if (a.confirm && !(await confirm({ title: a.label, body: a.confirm, confirmLabel: 'Run', danger: true }))) return;
    const out = await run(a.id, params, undefined, { confirmed: Boolean(a.confirm) });
    // Refused or failed: the params dialog stays with what was typed and says why (message), so one field can be fixed.
    if (out === null && fromDialog) return;
    setWithParams(null);
    if (out && 'runId' in out) void navigate({ to: '/runs' });
    else setOutputOf(a.label);
  };
  const pick = (a: ActionMeta) => {
    onOpenChange(false);
    if (needsParamsDialog(a)) {
      setMessage(null);
      setWithParams(a);
    }
    else void execute(a, {});
  };
  return (
    <>
      <Command.Dialog open={open} onOpenChange={onOpenChange} label="Command palette" overlayClassName="dialog__overlay" contentClassName="palette" loop>
        <Command.Input placeholder="Go to a page, run an action or start a mode" className="palette__input" />
        <Command.List className="palette__list">
          <Command.Empty className="palette__empty">No matches.</Command.Empty>
          <Command.Group heading="Go to">
            {NAV_GROUPS.flatMap((g) => g.items).map((item) => (
              <Command.Item key={item.to} value={`go ${item.label}`} onSelect={() => go(item.to)}>
                {item.label}
              </Command.Item>
            ))}
            <Command.Item value="evaluate url quick evaluate" onSelect={() => go('/')}>
              Evaluate a URL (Today)
            </Command.Item>
          </Command.Group>
          <Command.Group heading="Appearance">
            {THEME_MODES.map((m) => (
              <Command.Item
                key={m}
                value={`Theme: ${THEME_OPTIONS[m].label} appearance`}
                onSelect={() => {
                  onOpenChange(false);
                  setMode(m);
                }}
              >
                Theme: {THEME_OPTIONS[m].label} <span className="faint small">{THEME_OPTIONS[m].hint}</span>
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Actions">
            {(actions.data ?? []).map((a) => (
              <Command.Item key={a.id} value={`run ${a.label} ${a.id}`} onSelect={() => pick(a)}>
                {a.label} <CostPill cost={a.cost} /> <span className="faint mono small">{a.id}</span>
                {requiredParams(a).length > 0 && <span className="faint small">asks for {requiredParams(a).join(', ')}</span>}
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Start a session">
            {(modes.data ?? []).map((m) => (
              <Command.Item
                key={m.id}
                value={`mode ${m.id}`}
                onSelect={() => {
                  onOpenChange(false);
                  setLaunch(m.id);
                }}
              >
                {m.id} <span className="faint small">{m.policyClass}</span>
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command.Dialog>
      {launch && <ModeLaunchDialog mode={launch} onClose={() => setLaunch(null)} />}
      {outputOf && output !== null && <ActionOutputDialog label={outputOf} text={output} onClose={() => setOutputOf(null)} />}
      {withParams && <ActionParamsDialog action={withParams} error={message?.tone === 'danger' ? message.text : null} onClose={() => setWithParams(null)} onRun={(p) => execute(withParams, p, true)} />}
    </>
  );
}
