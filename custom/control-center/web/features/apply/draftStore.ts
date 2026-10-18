// What the Apply page keeps beside each session it starts, by session id (sessionStorage, like the remembered session
// itself): the only owner of these keys and their format (ApplyPage.invariants.md, 3). A storage that refuses only loses
// the re-attaching of that piece.
import { rowIdentity, sameRow, type RowIdentity } from '../tracker/StatusControl';

// The CV PDF and cover letter a draft's prompt named, so a re-attached draft fills with the documents its answers were
// drafted for, not the row's suggested ones. '' is an explicit "none"; null is no choice made, which leaves room for a
// document generated since.
export type DraftDocs = { pdf: string | null; cover: string | null };

const KEYS = {
  // The apply link typed for a draft: a row's session targets the row, not the link, so the link is kept beside it.
  typedUrl: (sid: string) => `cc.apply.typedUrl.${sid}`,
  docs: (sid: string) => `cc.apply.docs.${sid}`,
  // The application a row's session was started for. A tracker number is reused once its row is deleted (the next
  // addition takes max + 1), so a session remembered under the number is the shown row's only while it is that one.
  row: (sid: string) => `cc.apply.row.${sid}`,
};

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // storage refused: only this piece's re-attaching is lost
  }
}
function readJson(key: string): Record<string, unknown> | null {
  const raw = read(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const readTypedUrl = (sid: string | null): string | null => (sid ? read(KEYS.typedUrl(sid)) : null);
export const writeTypedUrl = (sid: string, url: string | null): void => write(KEYS.typedUrl(sid), url);

export function readDraftDocs(sid: string | null): DraftDocs | null {
  const parsed = sid ? readJson(KEYS.docs(sid)) : null;
  if (!parsed) return null;
  const pick = (v: unknown) => (typeof v === 'string' ? v : null);
  return { pdf: pick(parsed.pdf), cover: pick(parsed.cover) };
}
export const writeDraftDocs = (sid: string, docs: DraftDocs): void => write(KEYS.docs(sid), JSON.stringify({ pdf: docs.pdf, cover: docs.cover }));

export function readSessionRow(sid: string): RowIdentity | null {
  const p = readJson(KEYS.row(sid));
  if (!p || typeof p.company !== 'string' || typeof p.role !== 'string' || !(p.report === null || typeof p.report === 'number')) return null;
  return { company: p.company, role: p.role, report: p.report };
}
export const writeSessionRow = (sid: string, row: RowIdentity): void => write(KEYS.row(sid), JSON.stringify(rowIdentity(row)));

/** Releases every key kept beside the session: the one way a draft the page lets go of leaves nothing behind. */
export function forgetDraft(sid: string): void {
  for (const key of Object.values(KEYS)) write(key(sid), null);
}

/**
 * Whether the session was started for another application than `identity`, the one now under its row number. The row
 * the server pinned on the session (#264) decides when there is one; else the marker this page wrote; a session with
 * neither (started elsewhere, before rows were pinned) is taken as the row's.
 */
export function startedForOther(sid: string | null, identity: RowIdentity | undefined, pinned?: RowIdentity): boolean {
  if (!sid || !identity) return false;
  const row = pinned ?? readSessionRow(sid);
  return row !== null && !sameRow(row, identity);
}
