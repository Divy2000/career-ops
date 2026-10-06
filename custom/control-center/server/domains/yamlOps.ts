// Structured edits to user YAML files through the yaml Document API, so
// comments, key order and unknown keys survive every save (spec 3.4).
import { Composer, Parser, parseDocument, isScalar, isSeq, type CST, type Document } from 'yaml';
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
  const edited = keepCommentIndents(raw);
  let changed = false;
  for (const op of ops) {
    const label = op.path.join('.');
    try {
      if (applyOne(edited, op, label)) changed = true;
    } catch (err) {
      if (err instanceof YamlOpsError) throw err;
      // A path through a value that is not a map or list (yaml's own "Expected YAML collection"): a 400 with the reason.
      throw new YamlOpsError(`cannot ${op.op} ${label}: ${(err as Error).message.split('\n')[0]}`, 'bad-op');
    }
  }
  // Only no-op deletes: the file is left exactly as it was, comments and layout included.
  return changed ? edited.toString() : raw;
}

type BlockCollection = CST.BlockMap | CST.BlockSequence;
const isBlockCollection = (t: CST.Token | null | undefined): t is BlockCollection => t?.type === 'block-map' || t?.type === 'block-seq';
const isBlank = (t: CST.SourceToken) => t.type === 'newline' || t.type === 'space';

/**
 * The yaml composer gives every comment after a nested block's last entry to that block when the block ends in a
 * comment of its own, and prints them all at its indent. A commented-out top-level section after it would then move
 * under the section above, and uncommenting it later would nest it there. So before composing, the comments written
 * at an outer indent move out of the block to the entry that follows it, where they print at the indent they had.
 * Only a valid document gets here, so the composed one has no errors.
 */
function keepCommentIndents(raw: string): Document {
  const column = (offset: number) => offset - (raw.lastIndexOf('\n', offset - 1) + 1);
  // `atEnd` takes the outer comments of the block's last entry: a nested block keeps them as its own trailing entry
  // (for its parent to move on), the document root hands them to the document's end, where they print at column 0.
  const hoist = (block: BlockCollection, atEnd: (outer: CST.SourceToken[]) => void) => {
    for (let i = 0; i < block.items.length; i++) {
      const child = block.items[i]!.value;
      if (!isBlockCollection(child)) continue;
      hoist(child, (outer) => child.items.push({ start: outer }));
      const outer = takeOuterTail(child, column);
      if (outer.length === 0) continue;
      const next = block.items[i + 1];
      if (next) next.start.unshift(...outer);
      else atEnd(outer);
    }
  };
  const tokens = [...new Parser().parse(raw)];
  for (const t of tokens) {
    if (t.type === 'document' && isBlockCollection(t.value)) hoist(t.value, (outer) => (t.end = [...outer, ...(t.end ?? [])]));
  }
  return new Composer().compose(tokens, true, raw.length).next().value as Document;
}

/** Removes and returns the comment lines (with the blank lines before them) that close `block` at a smaller indent. */
function takeOuterTail(block: BlockCollection, column: (offset: number) => number): CST.SourceToken[] {
  const last = block.items.at(-1);
  if (!last || last.key !== undefined || last.sep || last.value || !last.start.every((t) => t.type === 'comment' || isBlank(t))) return [];
  const start = last.start;
  const first = start.findIndex((t) => t.type === 'comment' && column(t.offset) < block.indent);
  if (first < 0) return [];
  let from = first;
  while (from > 0 && isBlank(start[from - 1]!)) from--;
  // The newline right after the block's own last comment ends that comment's line; it stays with it.
  if (from > 0 && start[from]!.type === 'newline') from++;
  const outer = start.splice(from);
  if (start.length === 0) block.items.pop();
  return outer;
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
