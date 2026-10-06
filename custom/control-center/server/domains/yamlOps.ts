// Structured edits to user YAML files through the yaml Document API, so
// comments, key order and unknown keys survive every save (spec 3.4).
import { parseDocument, isScalar, isSeq, type Document } from 'yaml';
import { z } from 'zod';

export const yamlPathSchema = z.array(z.union([z.string().min(1).max(100), z.number().int().nonnegative()])).min(1).max(12);

export const yamlOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: yamlPathSchema, value: z.unknown().refine((v): boolean => v !== undefined, 'value is required') }),
  z.object({ op: z.literal('delete'), path: yamlPathSchema }),
  z.object({ op: z.literal('insert'), path: yamlPathSchema, index: z.number().int().nonnegative().optional(), value: z.unknown().refine((v): boolean => v !== undefined, 'value is required') }),
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
  let changed = false;
  for (const op of ops) {
    const label = op.path.join('.');
    try {
      if (applyOne(doc, op, label)) changed = true;
    } catch (err) {
      if (err instanceof YamlOpsError) throw err;
      // A path through a value that is not a map or list (yaml's own "Expected YAML collection"): a 400 with the reason.
      throw new YamlOpsError(`cannot ${op.op} ${label}: ${(err as Error).message.split('\n')[0]}`, 'bad-op');
    }
  }
  // Only no-op deletes: the file is left exactly as it was, comments and layout included.
  return changed ? doc.toString() : raw;
}

/**
 * An empty value on the way (a key with only commented children, `followup_cadence:`) is no map yet: it becomes the
 * map or list the next path step needs, as a missing key would.
 */
function fillEmptyParents(doc: Document, path: Array<string | number>): void {
  for (let i = 1; i < path.length; i++) {
    const node = doc.getIn(path.slice(0, i), true);
    if (isScalar(node) && node.value === null) doc.setIn(path.slice(0, i), doc.createNode(typeof path[i] === 'number' ? [] : {}));
  }
}

/** Applies one op; false when it had nothing to do (a delete of something absent). */
function applyOne(doc: Document, op: YamlOp, label: string): boolean {
  if (op.op === 'set') {
    fillEmptyParents(doc, op.path);
    doc.setIn(op.path, doc.createNode(op.value));
  } else if (op.op === 'delete') {
    // Nothing there (no file, no map, an empty value): nothing to delete.
    if (!doc.hasIn(op.path)) return false;
    doc.deleteIn(op.path);
  } else {
    fillEmptyParents(doc, op.path);
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
  return true;
}

/** Parsed JS view of a YAML text, or null with the parse error when it is malformed. */
export function parseYamlDoc(raw: string): { doc: unknown; parseError: string | null } {
  const d = parseDocument(raw);
  if (d.errors.length > 0) return { doc: null, parseError: d.errors[0]!.message.split('\n')[0] ?? 'parse error' };
  return { doc: d.toJS() ?? null, parseError: null };
}
