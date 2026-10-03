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

/** Runs a registry action; sync actions resolve with the result, async ones with a run id. Feedback goes to a toast and to the page message. */
export function useRunAction() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const run = async (id: string, params: Record<string, unknown> = {}, okText?: string): Promise<ActionOutcome | null> => {
    setBusy(id);
    setMessage(null);
    try {
      const out = await apiSend<ActionOutcome>('POST', `/api/actions/${id}`, { params });
      const text = okText ?? ('runId' in out ? `Started run ${out.runId}` : 'Done');
      setMessage({ tone: 'ok', text });
      toast.success(text);
      await qc.invalidateQueries({ queryKey: ['runs'] });
      return out;
    } catch (err) {
      const text = `Could not run ${id}: ${describeError(err)}`;
      setMessage({ tone: 'danger', text });
      toast.error(text);
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { run, busy, message, setMessage };
}
