// Client-side mirror of the server's yaml ops, applied to the parsed JS view
// so the structured editors show pending edits before they are validated and saved.
import type { YamlOp } from '@shared/api';

export type JsonPath = Array<string | number>;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function container(root: unknown, path: JsonPath, create: boolean): { parent: Record<string, unknown> | unknown[]; key: string | number } | null {
  let node: unknown = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i]!;
    const next = typeof key === 'number' ? (Array.isArray(node) ? node[key] : undefined) : node && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined;
    if (next === undefined || next === null) {
      if (!create) return null;
      const fresh: unknown = typeof path[i + 1] === 'number' ? [] : {};
      if (Array.isArray(node) && typeof key === 'number') node[key] = fresh;
      else if (node && typeof node === 'object') (node as Record<string, unknown>)[key as string] = fresh;
      else return null;
      node = fresh;
    } else node = next;
  }
  if (!node || typeof node !== 'object') return null;
  return { parent: node as Record<string, unknown> | unknown[], key: path[path.length - 1]! };
}

/** Pure: returns a new root with the op applied (set creates intermediate containers, like the yaml Document API). */
export function applyOpJs(root: unknown, op: YamlOp): unknown {
  const next: unknown = root === null || root === undefined ? (typeof op.path[0] === 'number' ? [] : {}) : clone(root);
  const slot = container(next, op.path, op.op !== 'delete');
  if (!slot) return next;
  const { parent, key } = slot;
  if (op.op === 'set') {
    if (Array.isArray(parent) && typeof key === 'number') parent[key] = op.value;
    else (parent as Record<string, unknown>)[String(key)] = op.value;
  } else if (op.op === 'delete') {
    if (Array.isArray(parent) && typeof key === 'number') parent.splice(key, 1);
    else delete (parent as Record<string, unknown>)[String(key)];
  } else {
    const existing = Array.isArray(parent) && typeof key === 'number' ? parent[key] : (parent as Record<string, unknown>)[String(key)];
    const list = Array.isArray(existing) ? existing : [];
    list.splice(Math.min(op.index ?? list.length, list.length), 0, op.value);
    if (Array.isArray(parent) && typeof key === 'number') parent[key] = list;
    else (parent as Record<string, unknown>)[String(key)] = list;
  }
  return next;
}

export function applyOpsJs(root: unknown, ops: YamlOp[]): unknown {
  return ops.reduce((acc, op) => applyOpJs(acc, op), root);
}

export const isScalar = (v: unknown): v is string | number | boolean | null => v === null || ['string', 'number', 'boolean'].includes(typeof v);
export const isPlainObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
