import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { apiGet, apiSend, type ApiError } from './api';
import type { ActionMeta } from '@shared/api';

export type ActionOutcome = { runId: string } | { result: unknown; stderr?: string };

export const useActions = () => useQuery({ queryKey: ['actions'], queryFn: () => apiGet<ActionMeta[]>('/api/actions'), staleTime: 60_000 });

export function describeError(err: unknown): string {
  const e = err as ApiError;
  const body = e?.body as { error?: string; stderr?: string } | null | undefined;
  return `${body?.error ?? e?.message ?? 'unknown error'}${body?.stderr ? ` (${body.stderr.trim().slice(-200)})` : ''}`;
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
