// Envelope contract: one per line, outside code fences: <<cc:KIND {json}>>.
import { z } from 'zod';

export const ENVELOPE_SCHEMAS = {
  answers: z.object({
    fields: z.array(
      z.object({
        id: z.string().min(1),
        label: z.string(),
        type: z.string(),
        options: z.array(z.string()).optional(),
        required: z.boolean().default(false),
        value: z.string().default(''),
        needsConfirmation: z.boolean().default(false),
      }),
    ),
  }),
  offer: z.object({
    url: z.string().url(),
    company: z.string(),
    title: z.string(),
    location: z.string().optional(),
    source: z.string().optional(),
    salary: z.string().optional(),
    postedAt: z.string().optional(),
    notes: z.string().optional(),
  }),
  cv: z.object({ markdown: z.string().min(1) }),
  act: z.object({ action: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}) }),
} as const;

export type EnvelopeKind = keyof typeof ENVELOPE_SCHEMAS;

export type Envelope = { ok: true; kind: EnvelopeKind; payload: unknown; raw: string } | { ok: false; kind: string; error: string; raw: string };

// Non-greedy braces end at the first `}>>`, which is the envelope's own closer even with nested objects.
const ENVELOPE_RE = /<<cc:([a-z-]+)\s+(\{.*?\})>>/g;

/**
 * Pull envelopes out of assistant text. Fenced lines are left alone, a partial
 * opener at the end is hidden while streaming (alpha behavior), and every
 * payload is validated; invalid ones come back as warnings, never dropped.
 */
export function extractEnvelopes(text: string, streaming: boolean): { envelopes: Envelope[]; visibleText: string } {
  const envelopes: Envelope[] = [];
  const visible: string[] = [];
  let inFence = false;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      visible.push(line);
      return;
    }
    if (inFence) {
      visible.push(line);
      return;
    }
    let found = false;
    const rest = line.replace(ENVELOPE_RE, (raw, kind: string, json: string) => {
      found = true;
      envelopes.push(validate(kind, json, raw));
      return '';
    });
    if (found) {
      if (rest.trim()) visible.push(rest.trimEnd());
      return;
    }
    if (streaming && i === lines.length - 1) {
      const open = line.lastIndexOf('<<cc:');
      if (open !== -1 && !line.slice(open).includes('>>')) {
        visible.push(line.slice(0, open));
        return;
      }
    }
    visible.push(line);
  });
  return { envelopes, visibleText: visible.join('\n') };
}

function validate(kind: string, json: string, raw: string): Envelope {
  const schema = (ENVELOPE_SCHEMAS as Record<string, z.ZodType>)[kind];
  if (!schema) return { ok: false, kind, error: `unknown envelope kind ${kind}`, raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, kind, error: `invalid JSON: ${(err as Error).message}`, raw };
  }
  const r = schema.safeParse(parsed);
  if (!r.success) return { ok: false, kind, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '), raw };
  return { ok: true, kind: kind as EnvelopeKind, payload: r.data, raw };
}
