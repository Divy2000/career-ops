import fs from 'node:fs';
import path from 'node:path';
import { englishModeOf } from '../claude/modes.js';

/**
 * reply-watch.mjs (upstream) writes a set of mock emails to data/reply-candidates.json when the file is missing, and
 * paste-reply only ever appends to it, so running it before the first pasted reply would make those mocks permanent.
 * The digest action and a reply-watch session both refuse until a reply has been pasted.
 */
export function replyWatchRefused(dataRoot: string): string | null {
  const file = path.join(dataRoot, 'data', 'reply-candidates.json');
  return fs.existsSync(file) && !onlySeededMocks(file) ? null : 'No replies to review yet. Paste a reply first, then run the digest.';
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

/** True when the file is a non-empty list of seeded mocks only. Anything else (a pasted reply, or a file the script cannot read) is left to reply-watch.mjs. */
function onlySeededMocks(file: string): boolean {
  let entries: unknown;
  try {
    entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return entries.every((e) => {
    const c = (e ?? {}) as { message_id?: unknown; from?: unknown; subject?: unknown };
    return SEEDED_MOCKS.has([c.message_id, c.from, c.subject].map(String).join('\n'));
  });
}

/** The same refusal for a session turn: only a reply-watch session runs reply-watch.mjs. */
export function replyWatchSessionRefused(dataRoot: string, mode: string): string | null {
  return englishModeOf(mode) === 'reply-watch' ? replyWatchRefused(dataRoot) : null;
}
