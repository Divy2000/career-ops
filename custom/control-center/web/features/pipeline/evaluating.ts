import type { SessionMeta } from '@shared/api';
import { dedupUrlKey } from '@shared/dedup-url';
import { localJdPath } from '@shared/local-jd';

// A session waiting for the user's reply still owns its row: answering it finishes the evaluation.
const LIVE = new Set(['queued', 'running', 'awaiting_user']);

// The browser's copy of server/claude/honesty.ts isReportGated (with modes.ts englishModeOf), which it cannot import;
// tests/web/evaluating-targets-r28.test.ts holds the two together.
const OFERTA_TRANSLATIONS = new Set(['ar/fursah', 'de/angebot', 'fr/offre', 'hi/naukri', 'id/lowongan', 'it/annuncio', 'ja/kyujin', 'ko/gonggo', 'nl/vacature', 'tr/is-ilani']);
const LANGUAGE_DIR = /^[a-z]{2}(-[A-Z]{2})?\//;

/** Modes that evaluate one posting and write its report and tracker row (oferta, auto-pipeline, a localized oferta). */
export function isReportGatedMode(mode: string): boolean {
  if (OFERTA_TRANSLATIONS.has(mode)) return true;
  const english = mode.replace(LANGUAGE_DIR, '');
  return english === 'oferta' || english === 'auto-pipeline' || mode.endsWith('/oferta');
}

/**
 * Process inbox: pipeline mode or a language-directory spelling of it (de/pipeline), as the server's isProcessInbox
 * reads it through englishModeOf. No translated mode stands for pipeline.
 */
export function isProcessInboxMode(mode: string): boolean {
  return mode.replace(LANGUAGE_DIR, '') === 'pipeline';
}

// What the server's duplicate guard compares (manager.ts postingKey): a saved JD by its jds/ file, a posting by its
// dedup key, so two spellings of one posting are one.
function targetKey(ref: string): string {
  const jd = localJdPath(ref);
  return jd !== null ? `jds\0${jd}` : `url\0${dedupUrlKey(ref)}`;
}

/** GET /api/sessions marks a session whose status ended while its process is still stopping. */
type ListedSession = SessionMeta & { stopping?: true };

function sessionKey(target: SessionMeta['target']): string | null {
  if (!target.value) return null;
  if (target.type === 'url') return `url\0${dedupUrlKey(target.value)}`;
  const jd = target.type === 'text' ? localJdPath(target.value) : null;
  return jd !== null ? `jds\0${jd}` : null;
}

/**
 * The posting URLs and saved-JD references a report-gated session is evaluating right now. The server refuses a second
 * evaluation of the same posting, and a row stays pending until its evaluation is done, so pages leave these out of a
 * new start. A cancelled one still stopping counts too: the server refuses its target until it exits. `has` takes a
 * row's reference as written.
 */
export function evaluatingTargets(sessions: ListedSession[] | undefined): { has: (ref: string) => boolean } {
  const keys = new Set((sessions ?? []).filter((s) => isReportGatedMode(s.mode) && (LIVE.has(s.status) || s.stopping === true)).map((s) => sessionKey(s.target)));
  return { has: (ref) => keys.has(targetKey(ref)) };
}
