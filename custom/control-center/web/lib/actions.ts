import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { apiGet, apiSend, type ApiError } from './api';
import type { ActionMeta } from '@shared/api';

/** A sync action's answer; findings: the check ran and found problems (its output says which), not a failure to run. */
export type ActionOutcome = { runId: string } | { result: unknown; stderr?: string; findings?: string };

export const useActions = () => useQuery({ queryKey: ['actions'], queryFn: () => apiGet<ActionMeta[]>('/api/actions'), staleTime: 60_000 });

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
  const body = e?.body as { error?: string; message?: unknown; stderr?: string; issues?: unknown } | null | undefined;
  // A schema label ("invalid body", or one with a hint: "invalid rows: company, since ...") says what was refused, not
  // where. A route that wrote the issues into its error in its own words (the projects routes: "bullet 2 must be one
  // line") would show them twice, and so would a label that already quotes every issue's message.
  const error = body?.error ?? '';
  const list = Array.isArray(body?.issues) ? (body.issues as Array<{ message?: unknown }>) : [];
  const said = list.length > 0 && list.every((i) => error.includes(String(i.message ?? '')));
  const issues = /^invalid\b/.test(error) && !said ? describeIssues(body?.issues) : '';
  // Fastify's own error body (an unhandled throw) names the status in error and puts the reason in message.
  const reason = typeof body?.message === 'string' && body.message.trim() && body.message !== body.error ? `: ${body.message.trim()}` : '';
  return `${body?.error ?? e?.message ?? 'unknown error'}${reason}${issues}${body?.stderr ? ` (${body.stderr.trim().slice(-200)})` : ''}`;
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
      if ('findings' in out && out.findings) {
        setMessage({ tone: 'danger', text: out.findings });
        setOutput(actionOutputText(out.result, out.stderr));
        toast.warning(out.findings);
        await qc.invalidateQueries({ queryKey: ['runs'] });
        return out;
      }
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
