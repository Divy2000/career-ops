// Pure text edits for data/follow-ups.md. Plain .mjs so the child process that
// holds the core follow-ups lock can import it without a TypeScript loader.
const HEADER = '| num | appNum | date | company | role | channel | contact | notes |';
const SEPARATOR = '|---|---|---|---|---|---|---|---|';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ').trim();

// A follow-up row as followup-cadence.mjs parseFollowups reads one: eight cells, a numeric num and appNum.
function isRow(line) {
  if (!line.startsWith('|')) return false;
  const parts = line.split('|').map((s) => s.trim());
  return parts.length >= 8 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2]);
}

const rowNum = (line) => parseInt(line.split('|')[1], 10);

/** A table header row of at least the eight follow-up columns. */
const isHeader = (line) => line.trimStart().startsWith('|') && line.split('|').map((s) => s.trim()).filter(Boolean).length >= 8;

function isSeparator(line) {
  return line !== undefined && /^\s*\|\s*:?-{3,}/.test(line);
}

function pinRe(appNum) {
  return new RegExp(`^-\\s+next\\s+#${appNum}\\s+\\d{4}-\\d{2}-\\d{2}`, 'i');
}

// followup-cadence.mjs: a `- cleared #N` retirement outranks any pin, so pinning a retired application revives it.
// The whole CLEARED_RE grammar: a line the cadence does not read as a retirement is the user's text and stays.
function isCleared(line, appNum) {
  const m = line.match(new RegExp(`^-\\s+cleared\\s+#${appNum}\\s+(\\d{4}-\\d{2}-\\d{2})(?:\\s*[\u2014\u2013-].*)?\\s*$`, 'i'));
  if (!m) return false;
  // followup-cadence.mjs parseDate: an impossible day (2026-02-31) is no retirement.
  const d = new Date(m[1]);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === m[1];
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
      // The upstream readers take follow-up rows by position, whatever the header labels say, so the table is the first
      // header of eight or more columns over a `|---` separator; nums are unique across every follow-up row in the file.
      let headerAt = lines.findIndex((l, i) => isHeader(l) && isSeparator(lines[i + 1]));
      const maxNum = lines.reduce((max, l) => (isRow(l) ? Math.max(max, rowNum(l) || 0) : max), 0);
      if (headerAt === -1) {
        if (lines.length === 0) lines.push('# Follow-up History', '');
        lines.push(HEADER, SEPARATOR);
        headerAt = lines.length - 2;
      }
      // The new row goes after the table's last row: the table ends at its first line that is not a table line.
      let lastRow = headerAt + 1;
      for (let i = headerAt + 2; i < lines.length && lines[i].trimStart().startsWith('|'); i++) if (isRow(lines[i])) lastRow = i;
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
      const kept = lines.filter((l) => !re.test(l) && !isCleared(l, edit.appNum));
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
