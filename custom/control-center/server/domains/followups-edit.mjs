// Pure text edits for data/follow-ups.md. Plain .mjs so the child process that
// holds the core follow-ups lock can import it without a TypeScript loader.
const HEADER = '| num | appNum | date | company | role | channel | contact | notes |';
const SEPARATOR = '|---|---|---|---|---|---|---|---|';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ').trim();

function isRow(line) {
  return /^\|\s*\d+\s*\|/.test(line);
}

const rowNum = (line) => parseInt(line.split('|')[1], 10);

function isSeparator(line) {
  return line !== undefined && /^\s*\|\s*:?-{3,}/.test(line);
}

function pinRe(appNum) {
  return new RegExp(`^-\\s+next\\s+#${appNum}\\s+\\d{4}-\\d{2}-\\d{2}`, 'i');
}

// followup-cadence.mjs: a `- cleared #N` retirement outranks any pin, so pinning a retired application revives it.
function clearedRe(appNum) {
  return new RegExp(`^-\\s+cleared\\s+#${appNum}\\s+\\d{4}-\\d{2}-\\d{2}`, 'i');
}

/**
 * @param {string} text current file contents ('' when missing)
 * @param {object} edit one of log.add, log.delete, pin.set, pin.clear
 * @returns {{ok:true,text:string,num?:number}|{ok:false,error:string}}
 */
export function applyFollowupEdit(text, edit) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const join = (arr) => arr.join(nl) + nl;

  switch (edit.op) {
    case 'log.add': {
      if (!DATE_RE.test(String(edit.date))) return { ok: false, error: 'invalid-date' };
      if (!Number.isInteger(edit.appNum) || edit.appNum <= 0) return { ok: false, error: 'invalid-app' };
      // The upstream readers take the table by position, whatever its header labels say, so the first header row
      // (a `|` line over a `|---` separator) is the table; nums are unique across every row in the file.
      let headerAt = lines.findIndex((l, i) => l.trimStart().startsWith('|') && isSeparator(lines[i + 1]));
      const maxNum = lines.reduce((max, l) => (isRow(l) ? Math.max(max, rowNum(l) || 0) : max), 0);
      if (headerAt === -1) {
        if (lines.length === 0) lines.push('# Follow-up History', '');
        lines.push(HEADER, SEPARATOR);
        headerAt = lines.length - 2;
      }
      let lastRow = headerAt + 1;
      for (let i = headerAt + 1; i < lines.length; i++) if (isRow(lines[i])) lastRow = i;
      const num = maxNum + 1;
      const row = `| ${num} | ${edit.appNum} | ${edit.date} | ${cell(edit.company)} | ${cell(edit.role)} | ${cell(edit.channel)} | ${cell(edit.contact)} | ${cell(edit.notes)} |`;
      lines.splice(lastRow + 1, 0, row);
      return { ok: true, text: join(lines), num };
    }
    case 'log.delete': {
      const matches = lines.flatMap((l, i) => (isRow(l) && rowNum(l) === edit.num ? [i] : []));
      if (matches.length === 0) return { ok: false, error: 'not-found' };
      // A num written twice (a hand edit, or an older second table) cannot say which application's row is meant.
      if (matches.length > 1) return { ok: false, error: 'ambiguous' };
      const idx = matches[0];
      lines.splice(idx, 1);
      return { ok: true, text: join(lines) };
    }
    case 'pin.set': {
      if (!DATE_RE.test(String(edit.date)) || !DATE_RE.test(String(edit.setOn))) return { ok: false, error: 'invalid-date' };
      const re = pinRe(edit.appNum);
      const cleared = clearedRe(edit.appNum);
      const kept = lines.filter((l) => !re.test(l) && !cleared.test(l));
      kept.push(`- next #${edit.appNum} ${edit.date} (set ${edit.setOn})`);
      return { ok: true, text: join(kept) };
    }
    case 'pin.clear': {
      const re = pinRe(edit.appNum);
      const kept = lines.filter((l) => !re.test(l));
      if (kept.length === lines.length) return { ok: false, error: 'not-found' };
      return { ok: true, text: join(kept) };
    }
    default:
      return { ok: false, error: 'unknown-op' };
  }
}
