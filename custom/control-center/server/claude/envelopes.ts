// Envelope contract: one per line, outside code fences: <<cc:KIND {json}>>.
import { z } from 'zod';
import { splitEnvelopes } from '../../shared/envelope-text.js';
import { postingUrl } from '../../shared/posting-url.js';

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
    // The rule the pipeline add route checks by, so every offer shown can be added.
    url: z.string().refine((u) => postingUrl(u) !== null, 'not an http(s) posting URL the pipeline can take'),
    company: z.string(),
    title: z.string(),
    location: z.string().optional(),
    source: z.string().optional(),
    salary: z.string().optional(),
    postedAt: z.string().optional(),
    notes: z.string().optional(),
  }),
  cv: z.object({ markdown: z.string().min(1) }),
  projects: z.object({ markdown: z.string().min(1) }),
  act: z.object({ action: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}) }),
} as const;

export type EnvelopeKind = keyof typeof ENVELOPE_SCHEMAS;

export type Envelope = { ok: true; kind: EnvelopeKind; payload: unknown; raw: string } | { ok: false; kind: string; error: string; raw: string };

/**
 * Pull envelopes out of assistant text. Fenced lines are left alone, a partial
 * opener at the end is hidden while streaming (alpha behavior), and every
 * payload is validated; invalid ones come back as warnings, never dropped.
 */
export function extractEnvelopes(text: string, streaming: boolean): { envelopes: Envelope[]; visibleText: string } {
  const { found, visibleText } = splitEnvelopes(text, streaming);
  return { envelopes: found.map((e) => validate(e.kind, e.json, e.raw)), visibleText };
}

function validate(kind: string, json: string, raw: string): Envelope {
  // Own keys only: a kind like `constructor` must not reach Object.prototype.
  if (!Object.hasOwn(ENVELOPE_SCHEMAS, kind)) return { ok: false, kind, error: `unknown envelope kind ${kind}`, raw };
  const schema = (ENVELOPE_SCHEMAS as Record<string, z.ZodType>)[kind]!;
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
