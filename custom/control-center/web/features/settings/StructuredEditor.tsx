// Generic structured editor over a parsed YAML value. Every change becomes a
// granular yaml op (set, delete, insert) so the server can apply it through the
// Document API and keep comments; the parent applies the same op to its JS view.
import { useState, type ReactNode } from 'react';
import type { YamlOp } from '@shared/api';
import { isPlainObject, isScalar, type JsonPath } from '../../lib/yamlOpsClient';
import { Empty } from '../../components/ui';

export type OpSink = (op: YamlOp) => void;
/** Validators keyed by a dotted path pattern where `*` matches a list index. */
export type FieldRules = Record<string, (value: string) => string | null>;

export const pathLabel = (path: JsonPath) => path.join('.');

export function matchRule(rules: FieldRules | undefined, path: JsonPath): ((value: string) => string | null) | undefined {
  if (!rules) return undefined;
  const key = path.map((p) => (typeof p === 'number' ? '*' : p)).join('.');
  return rules[key];
}

function parseScalar(text: string, like: unknown): unknown {
  // Number('') is 0: a cleared field is not a number, or clearing auto_pdf_score_threshold would save 0.
  if (typeof like === 'number') return text.trim() === '' ? NaN : Number(text);
  if (typeof like === 'boolean') return text === 'true';
  return text;
}

/** A table cell takes the type of its column's other values; with none to copy, true and false are switches, as in Add key. */
function parseCell(text: string, like: unknown): unknown {
  const flag = like === undefined && (text === 'true' || text === 'false');
  return typeof like === 'boolean' || flag ? text === 'true' : parseScalar(text, like ?? '');
}

export function ScalarInput({ path, value, onOp, rules, ariaLabel, parse }: { path: JsonPath; value: unknown; onOp: OpSink; rules?: FieldRules; ariaLabel?: string; parse?: (text: string) => unknown }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = ariaLabel ?? pathLabel(path);
  if (typeof value === 'boolean') {
    return <input type="checkbox" aria-label={name} checked={value} onChange={(e) => onOp({ op: 'set', path, value: e.target.checked })} />;
  }
  const commit = () => {
    if (draft === null) return;
    const err = matchRule(rules, path)?.(draft) ?? null;
    if (err) {
      setError(err);
      return;
    }
    const next = parse ? parse(draft) : parseScalar(draft, value);
    if (typeof next === 'number' && Number.isNaN(next)) {
      setError('must be a number');
      return;
    }
    setError(null);
    if (next !== value) onOp({ op: 'set', path, value: next });
    setDraft(null);
  };
  return (
    <span className="field">
      <input
        aria-label={name}
        type={typeof value === 'number' ? 'number' : 'text'}
        value={draft ?? (value === null || value === undefined ? '' : String(value))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        aria-invalid={error ? true : undefined}
      />
      {error && (
        <span role="alert" className="danger-text small">
          {error}
        </span>
      )}
    </span>
  );
}

export function ScalarList({ path, items, onOp, rules }: { path: JsonPath; items: unknown[]; onOp: OpSink; rules?: FieldRules }) {
  const [add, setAdd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const name = pathLabel(path);
  const addItem = () => {
    const text = add.trim();
    if (!text) return;
    const err = matchRule(rules, [...path, 0])?.(text) ?? null;
    setError(err);
    if (err) return;
    onOp({ op: 'insert', path, value: parseScalar(text, items[0] ?? '') });
    setAdd('');
  };
  return (
    <div className="list-editor">
      {items.length === 0 && <Empty>Empty list.</Empty>}
      <ul className="list-editor__items">
        {items.map((item, i) => (
          <li key={`${i}-${String(item)}`} className="row gap">
            <ScalarInput path={[...path, i]} value={item} onOp={onOp} rules={rules} ariaLabel={`${name} item ${i + 1}`} />
            <button type="button" className="button--ghost" aria-label={`Remove ${name} item ${i + 1}`} onClick={() => onOp({ op: 'delete', path: [...path, i] })}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="row gap">
        <input aria-label={`Add to ${name}`} value={add} onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addItem()} placeholder="new entry" />
        <button type="button" onClick={addItem} disabled={!add.trim()}>
          Add
        </button>
      </div>
      {error && (
        <p role="alert" className="danger-text small">
          {error}
        </p>
      )}
    </div>
  );
}

const NAME_KEYS = ['name', 'company', 'id', 'slug', 'query', 'label', 'language'];

export function rowName(row: Record<string, unknown>, i: number): string {
  for (const k of NAME_KEYS) if (typeof row[k] === 'string' && row[k]) return row[k] as string;
  return `row ${i + 1}`;
}

/** A check on a whole new row (a field rule sees one cell): the error to show, or null. */
export type RowRule = (row: Record<string, unknown>) => string | null;

export function ObjectTable({ path, rows, onOp, rules, columnsHint = [], rowRule }: { path: JsonPath; rows: Record<string, unknown>[]; onOp: OpSink; rules?: FieldRules; columnsHint?: string[]; rowRule?: RowRule }) {
  const columns = [...new Set([...columnsHint, ...rows.flatMap((r) => Object.keys(r).filter((k) => isScalar(r[k])))])];
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const name = pathLabel(path);
  // A blank cell is an absent key or an explicit blank value (`enabled:` reads as null): neither has a type to copy.
  const blank = (v: unknown) => v === undefined || v === null;
  const columnLike = (col: string) => rows.find((r) => !blank(r[col]))?.[col];
  // A blank cell is typed like a new row's cell: false in a blank enabled cell is the boolean.
  const parseBlank = (col: string) => (text: string) => (text.trim() === '' ? '' : parseCell(text.trim(), columnLike(col)));
  const addRow = () => {
    const row: Record<string, unknown> = {};
    for (const col of columns) {
      const text = (draft[col] ?? '').trim();
      const err = matchRule(rules, [...path, 0, col])?.(text) ?? null;
      if (err) {
        setError(`${col}: ${err}`);
        return;
      }
      if (text === '') continue;
      row[col] = parseCell(text, columnLike(col));
    }
    if (Object.keys(row).length === 0) {
      setError('fill in at least one column');
      return;
    }
    const rowError = rowRule?.(row) ?? null;
    if (rowError) {
      setError(rowError);
      return;
    }
    setError(null);
    onOp({ op: 'insert', path, value: row });
    setDraft({});
  };
  return (
    <div className="table-wrap">
      <table className="table table--compact">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
            <th scope="col">
              <span className="sr-only">Row actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>{isScalar(row[c]) || row[c] === undefined ? <ScalarInput path={[...path, i, c]} value={row[c] ?? ''} onOp={onOp} rules={rules} ariaLabel={`${c} of ${rowName(row, i)}`} parse={blank(row[c]) ? parseBlank(c) : undefined} /> : <code className="faint small">{JSON.stringify(row[c])}</code>}</td>
              ))}
              <td>
                <button type="button" className="button--ghost" aria-label={`Remove ${rowName(row, i)}`} onClick={() => onOp({ op: 'delete', path: [...path, i] })}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
          <tr className="table__add-row">
            {columns.map((c) => (
              <td key={c}>
                <input aria-label={`New ${name} ${c}`} value={draft[c] ?? ''} onChange={(e) => setDraft({ ...draft, [c]: e.target.value })} placeholder={c} />
              </td>
            ))}
            <td>
              <button type="button" onClick={addRow}>
                Add row
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {error && (
        <p role="alert" className="danger-text small">
          {error}
        </p>
      )}
    </div>
  );
}

function AddKeyForm({ path, onOp }: { path: JsonPath; onOp: OpSink }) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const add = () => {
    const k = key.trim();
    if (!k) return;
    const v = value.trim();
    let parsed: unknown = v;
    if (v === 'true' || v === 'false') parsed = v === 'true';
    else if (v !== '' && !Number.isNaN(Number(v))) parsed = Number(v);
    else if (/^[[{]/.test(v)) {
      try {
        parsed = JSON.parse(v);
      } catch {
        parsed = v;
      }
    }
    onOp({ op: 'set', path: [...path, k], value: parsed });
    setKey('');
    setValue('');
  };
  const name = pathLabel(path) || 'root';
  return (
    <div className="row gap small">
      <input aria-label={`New key under ${name}`} value={key} onChange={(e) => setKey(e.target.value)} placeholder="key" />
      <input aria-label={`Value for new key under ${name}`} value={value} onChange={(e) => setValue(e.target.value)} placeholder="value (text, number, true/false or JSON)" />
      <button type="button" onClick={add} disabled={!key.trim()}>
        Add key
      </button>
    </div>
  );
}

/** The columns of a list of objects anywhere in a document, by its dotted path: an empty one still edits as a table. */
export type ColumnsAt = Record<string, string[]>;

export function ObjectFields({ path, value, onOp, rules, depth = 0, columnsAt }: { path: JsonPath; value: Record<string, unknown>; onOp: OpSink; rules?: FieldRules; depth?: number; columnsAt?: ColumnsAt }) {
  const keys = Object.keys(value);
  return (
    <div className="fields">
      {keys.length === 0 && <Empty>No keys yet.</Empty>}
      {keys.map((k) => (
        <div key={k} className="fields__row">
          <div className="fields__label">
            <span className="mono">{k}</span>
            <button type="button" className="button--ghost small" aria-label={`Remove ${pathLabel([...path, k])}`} onClick={() => onOp({ op: 'delete', path: [...path, k] })}>
              Remove
            </button>
          </div>
          <div className="fields__value">
            <KeyEditor path={[...path, k]} value={value[k]} onOp={onOp} rules={rules} depth={depth + 1} columnsAt={columnsAt} />
          </div>
        </div>
      ))}
      <AddKeyForm path={path} onOp={onOp} />
    </div>
  );
}

/** Dispatches on the value shape: scalar, list of scalars, list of objects, object, or a read-only JSON preview. */
export function KeyEditor({ path, value, onOp, rules, depth = 0, columnsHint: hint, columnsAt, rowRule }: { path: JsonPath; value: unknown; onOp: OpSink; rules?: FieldRules; depth?: number; columnsHint?: string[]; columnsAt?: ColumnsAt; rowRule?: RowRule }): ReactNode {
  const columnsHint = hint ?? columnsAt?.[pathLabel(path)];
  if (isScalar(value)) return <ScalarInput path={path} value={value} onOp={onOp} rules={rules} />;
  if (Array.isArray(value)) {
    // An empty list is a scalar list by shape; a section with columns is a list of objects even with no entries yet.
    if (value.length === 0 && columnsHint?.length) return <ObjectTable path={path} rows={[]} onOp={onOp} rules={rules} columnsHint={columnsHint} rowRule={rowRule} />;
    if (value.every(isScalar)) return <ScalarList path={path} items={value} onOp={onOp} rules={rules} />;
    if (value.every(isPlainObject)) return <ObjectTable path={path} rows={value} onOp={onOp} rules={rules} columnsHint={columnsHint} rowRule={rowRule} />;
  }
  if (isPlainObject(value) && depth < 3) return <ObjectFields path={path} value={value} onOp={onOp} rules={rules} depth={depth} columnsAt={columnsAt} />;
  return (
    <div>
      <p className="muted small">This shape is edited in the Raw YAML tab.</p>
      <pre tabIndex={0} className="log mono small">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
