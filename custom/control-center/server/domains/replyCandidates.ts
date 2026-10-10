import fs from 'node:fs';
import path from 'node:path';
import { englishModeOf } from '../claude/modes.js';

/**
 * reply-watch.mjs (upstream) writes a set of mock emails to data/reply-candidates.json when the file is missing, and
 * paste-reply only ever appends to it, so running it before the first pasted reply would make those mocks permanent.
 * The digest action and a reply-watch session both refuse until a reply has been pasted. An empty list holds none
 * either: paste-reply.mjs always writes the reply it pastes.
 */
export function replyWatchRefused(dataRoot: string): string | null {
  const file = path.join(dataRoot, 'data', 'reply-candidates.json');
  const entries = fs.existsSync(file) ? readEntries(file) : [];
  if (entries === null) return 'data/reply-candidates.json is not a JSON list of replies, so neither the digest nor Paste reply can use it. Fix or delete the file, then paste a reply.';
  return entries.some((e) => !isSeededMock(e)) ? null : 'No replies to review yet. Paste a reply first, then run the digest.';
}

/**
 * The mock emails reply-watch.mjs ensureCandidatesFile() seeds, by message_id, sender and subject. A direct run of the
 * script leaves the file behind holding only these, which is no pasted reply at all.
 */
const SEEDED_MOCKS = new Set(
  [
    ['msg1', 'recruiter@wingyun.com', '恭喜简历通过，杭州赢云贸易有限公司邀您面试'],
    ['msg2', 'hr@examplelabs.com', 'Update on your application for Full-stack Engineer'],
    ['msg3', 'alerts@zhaopin.com', 'Zhaopin job alert'],
    ['msg4', 'hr@somecompany.com', '补充信息'],
  ].map((k) => k.join('\n')),
);

/**
 * The file's entries, or null when it is not a JSON list of reply objects (reply-watch.mjs and paste-reply.mjs both fail
 * on a file that is not a list, and reply-watch.mjs on a null entry).
 */
function readEntries(file: string): unknown[] | null {
  try {
    const entries: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(entries) && entries.every((e) => typeof e === 'object' && e !== null && !Array.isArray(e)) ? entries : null;
  } catch {
    return null;
  }
}

function isSeededMock(entry: unknown): boolean {
  const c = (entry ?? {}) as { message_id?: unknown; from?: unknown; subject?: unknown };
  return SEEDED_MOCKS.has([c.message_id, c.from, c.subject].map(String).join('\n'));
}

/** The same refusal for a session turn: only a reply-watch session runs reply-watch.mjs. */
export function replyWatchSessionRefused(dataRoot: string, mode: string): string | null {
  return englishModeOf(mode) === 'reply-watch' ? replyWatchRefused(dataRoot) : null;
}
