// Structured edits to user YAML files through the yaml Document API, so
// comments, key order and unknown keys survive every save (spec 3.4).
import { parseDocument, isSeq } from 'yaml';
import { z } from 'zod';

export const yamlPathSchema = z.array(z.union([z.string().min(1).max(100), z.number().int().nonnegative()])).min(1).max(12);

export const yamlOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: yamlPathSchema, value: z.unknown().refine((v) => v !== undefined, 'value is required') }),
  z.object({ op: z.literal('delete'), path: yamlPathSchema }),
  z.object({ op: z.literal('insert'), path: yamlPathSchema, index: z.number().int().nonnegative().optional(), value: z.unknown().refine((v) => v !== undefined, 'value is required') }),
]);

export type YamlOp = z.infer<typeof yamlOpSchema>;

export class YamlOpsError extends Error {
  constructor(
    message: string,
    public code: 'malformed' | 'bad-op',
  ) {
    super(message);
    this.name = 'YamlOpsError';
  }
}

/** Applies ops to the YAML text and returns the new text; throws YamlOpsError, never writes. */
export function applyYamlOps(raw: string, ops: YamlOp[]): string {
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    throw new YamlOpsError(`current file is not valid YAML: ${first.message.split('\n')[0]}`, 'malformed');
  }
  if (ops.length === 0) return raw;
  for (const op of ops) {
    const label = op.path.join('.');
    if (op.op === 'set') {
      doc.setIn(op.path, doc.createNode(op.value));
    } else if (op.op === 'delete') {
      doc.deleteIn(op.path);
    } else {
      const parent = doc.getIn(op.path, true);
      if (parent === undefined) {
        doc.setIn(op.path, doc.createNode([op.value]));
      } else if (isSeq(parent)) {
        const at = Math.min(op.index ?? parent.items.length, parent.items.length);
        parent.items.splice(at, 0, doc.createNode(op.value));
      } else {
        throw new YamlOpsError(`insert target ${label} is not a list`, 'bad-op');
      }
    }
  }
  return doc.toString();
}

/** Parsed JS view of a YAML text, or null with the parse error when it is malformed. */
export function parseYamlDoc(raw: string): { doc: unknown; parseError: string | null } {
  const d = parseDocument(raw);
  if (d.errors.length > 0) return { doc: null, parseError: d.errors[0]!.message.split('\n')[0] ?? 'parse error' };
  return { doc: d.toJS() ?? null, parseError: null };
}
