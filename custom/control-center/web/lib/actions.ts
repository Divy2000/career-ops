import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { apiGet, apiSend, type ApiError } from './api';
import type { ActionMeta } from '@shared/api';

export type ActionOutcome = { runId: string } | { result: unknown; stderr?: string };

export const useActions = () => useQuery({ queryKey: ['actions'], queryFn: () => apiGet<ActionMeta[]>('/api/actions'), staleTime: 60_000 });

/**
 * Whether an action's schema (GET /api/actions describes it as JSON schema) takes `value` for string param `name`:
 * its pattern and maxLength. A schema that does not say, or is not loaded yet, takes it; the server still checks.
 */
export function paramAccepts(meta: ActionMeta | undefined, name: string, value: string): boolean {
  const prop = (meta?.params.properties as Record<string, { pattern?: string; maxLength?: number }> | undefined)?.[name];
  if (!prop) return true;
  if (prop.maxLength !== undefined && value.length > prop.maxLength) return false;
  if (prop.pattern === undefined) return true;
  let re: RegExp;
  try {
    re = new RegExp(prop.pattern, 'u');
  } catch {
    // A pattern this browser cannot compile decides nothing here; the server's own check still runs.
    return true;
  }
  return re.test(value);
}

const MAX_ISSUES = 3;

/** A schema refusal's zod issues as "field: message" ("urls item 3: ..."), so the user sees what to fix. */
function describeIssues(issues: unknown): string {
  if (!Array.isArray(issues) || issues.length === 0) return '';
  const one = (i: { path?: unknown; message?: unknown }) => {
    const where = (Array.isArray(i.path) ? i.path : []).map((p) => (typeof p === 'number' ? `item ${p + 1}` : String(p))).join(' ');
    return `${where ? `${where}: ` : ''}${String(i.message ?? 'invalid')}`;
  };
  const shown = issues.slice(0, MAX_ISSUES).map(one);
  if (issues.length > MAX_ISSUES) shown.push(`and ${issues.length - MAX_ISSUES} more`);
  return `: ${shown.join('; ')}`;
}

export function describeError(err: unknown): string {
  const e = err as ApiError;
  const body = e?.body as { error?: string; stderr?: string; issues?: unknown } | null | undefined;
  return `${body?.error ?? e?.message ?? 'unknown error'}${describeIssues(body?.issues)}${body?.stderr ? ` (${body.stderr.trim().slice(-200)})` : ''}`;
}

/**
 * What a sync action printed, for a page to show: its stdout (the result) and its whole stderr. Scripts report on
 * either stream (validate-portals.mjs lists its errors on stdout and exits 1; tracker.mjs sync --check writes only to
 * stderr), so neither is dropped, on success or failure. null when the action printed nothing.
 */
export function actionOutputText(result: unknown, stderr?: string): string | null {
  const out = result === null || result === undefined ? '' : typeof result === 'string' ? result.trimEnd() : JSON.stringify(result, null, 2);
  const text = [out, (stderr ?? '').trimEnd()].filter(Boolean).join('\n');
  return text || null;
}

/** Runs a registry action; sync actions resolve with the result, async ones with a run id. Feedback goes to a toast and to the page message. */
export function useRunAction() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  /** opts.confirmed: the user confirmed the action's dialog; an action marked confirm runs only with it. */
  const run = async (id: string, params: Record<string, unknown> = {}, okText?: string, opts: { confirmed?: boolean } = {}): Promise<ActionOutcome | null> => {
    setBusy(id);
    setMessage(null);
    setOutput(null);
    try {
      const out = await apiSend<ActionOutcome>('POST', `/api/actions/${id}`, opts.confirmed ? { params, confirmed: true } : { params });
      const text = okText ?? ('runId' in out ? `Started run ${out.runId}` : 'Done');
      setMessage({ tone: 'ok', text });
      if ('result' in out) setOutput(actionOutputText(out.result, out.stderr));
      toast.success(text);
      await qc.invalidateQueries({ queryKey: ['runs'] });
      return out;
    } catch (err) {
      const text = `Could not run ${id}: ${describeError(err)}`;
      setMessage({ tone: 'danger', text });
      const body = (err as ApiError)?.body as { result?: unknown; stderr?: string } | null | undefined;
      setOutput(body && typeof body === 'object' ? actionOutputText(body.result, body.stderr) : null);
      toast.error(text);
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { run, busy, message, setMessage, output };
}
