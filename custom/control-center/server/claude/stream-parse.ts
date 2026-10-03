// Normalizes `claude --output-format stream-json` lines into session events
// (spec 4.3). Shapes follow the P0 probes recorded in contract.json.
import { extractEnvelopes } from './envelopes.js';

export type SessionEvent =
  | { type: 'session.init'; model: string; tools: string[]; claudeSessionId: string }
  | { type: 'text.delta'; text: string }
  | { type: 'text.done'; text: string }
  | { type: 'tool.use'; id: string; name: string; summary: string }
  | { type: 'tool.result'; id: string; ok: boolean; summary: string }
  | { type: 'files.changed'; paths: string[] }
  | { type: 'permission.denied'; tool: string; input: unknown }
  | { type: 'envelope'; kind: string; payload: unknown }
  | { type: 'envelope.invalid'; kind: string; error: string; raw: string }
  | { type: 'turn.done'; costUsd: number; tokens: number; numTurns: number; isError: boolean }
  | { type: 'evaluation'; reports: Array<{ num: number; file: string; score: number | null }> }
  | { type: 'stderr'; text: string }
  | { type: 'status'; status: string; reason?: string; turn?: number }
  | { type: 'error'; message: string };

type Json = Record<string, unknown>;

export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Json;
  const pick = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : null);
  const s = pick('file_path') ?? pick('notebook_path') ?? pick('command') ?? pick('url') ?? pick('query') ?? pick('pattern') ?? pick('element') ?? JSON.stringify(i);
  return s.length > 200 ? `${s.slice(0, 200)}...` : s;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : typeof (c as Json).text === 'string' ? String((c as Json).text) : '')).join('');
  return '';
}

export class StreamParser {
  text = '';

  /** One stdout line in, zero or more normalized events out. Non-JSON lines surface as stderr text. */
  push(line: string): SessionEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let obj: Json;
    try {
      obj = JSON.parse(trimmed) as Json;
    } catch {
      return [{ type: 'stderr', text: line }];
    }
    switch (obj.type) {
      case 'system':
        if (obj.subtype === 'init') return [{ type: 'session.init', model: String(obj.model ?? ''), tools: Array.isArray(obj.tools) ? (obj.tools as string[]) : [], claudeSessionId: String(obj.session_id ?? '') }];
        return [];
      case 'stream_event': {
        const ev = (obj.event ?? {}) as Json;
        const delta = (ev.delta ?? {}) as Json;
        if (ev.type === 'content_block_delta' && typeof delta.text === 'string') {
          this.text += delta.text;
          return [{ type: 'text.delta', text: delta.text }];
        }
        return [];
      }
      case 'assistant':
        return this.blocks(obj).flatMap((b) => (b.type === 'tool_use' ? [{ type: 'tool.use', id: String(b.id), name: String(b.name), summary: toolSummary(String(b.name), b.input) } as SessionEvent] : []));
      case 'user':
        return this.blocks(obj).flatMap((b) => (b.type === 'tool_result' ? [{ type: 'tool.result', id: String(b.tool_use_id), ok: !b.is_error, summary: contentText(b.content).slice(0, 400) } as SessionEvent] : []));
      case 'result': {
        const out: SessionEvent[] = [];
        for (const d of (Array.isArray(obj.permission_denials) ? obj.permission_denials : []) as Json[]) out.push({ type: 'permission.denied', tool: String(d.tool_name ?? ''), input: d.tool_input });
        const finalText = typeof obj.result === 'string' && obj.result ? obj.result : this.text;
        const { envelopes, visibleText } = extractEnvelopes(finalText, false);
        for (const e of envelopes) out.push(e.ok ? { type: 'envelope', kind: e.kind, payload: e.payload } : { type: 'envelope.invalid', kind: e.kind, error: e.error, raw: e.raw });
        out.push({ type: 'text.done', text: visibleText });
        const usage = (obj.usage ?? {}) as Json;
        const tokens = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((sum, k) => sum + (typeof usage[k] === 'number' ? (usage[k] as number) : 0), 0);
        out.push({ type: 'turn.done', costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : 0, tokens, numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : 0, isError: Boolean(obj.is_error) });
        return out;
      }
      default:
        return [];
    }
  }

  private blocks(obj: Json): Json[] {
    const msg = (obj.message ?? {}) as Json;
    return Array.isArray(msg.content) ? (msg.content as Json[]) : [];
  }
}
