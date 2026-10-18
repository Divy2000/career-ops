// Static action registry: the only way the client runs anything. Every entry
// builds an argv array; the client never sends a command string.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import type { Cost, ExitMeaning } from '../runner/store.js';
import { cliScriptPath, importCore } from '../core/adapter.js';
import { readPdfIndex, rerenderProblem, resolveOutputFile } from '../domains/documents.js';
import { readTracker } from '../domains/tracker.js';
import { resolveTrackerFile } from '../domains/trackerPath.js';
import { listReportFiles, listReportNames, reportNumberOf } from '../domains/reports.js';
import { companyHistoryInputs } from '../domains/insightsCache.js';
import { containedTarget, OutsideRootsError } from '../lib/atomic-write.js';
import { RunStore } from '../runner/store.js';
import { prefillUrlProblem } from '../../shared/prefill.js';
import { outputFileProblem } from '../../shared/output-path.js';
import { NETWORK_SCAN_SOURCES } from '../../shared/network-scan.js';
import { STATUS_NOTE_MAX } from '../../shared/tracker-status.js';
import { writeTmpInput } from './tmp-inputs.js';
import { replyWatchRefused } from '../domains/replyCandidates.js';
import { heldReportNumsOf, SessionStore, sessionsDir } from '../claude/sessions.js';
import { turnClaimGone } from '../claude/process-claim.js';
import { processStartTime, readOrNull, removeIf, type ProcessStart } from '../../supervisor/instance-lock.js';

export type Resource = 'tracker' | 'pipeline' | 'portals' | 'profile' | 'followups' | 'cv' | 'blacklist' | 'launchd' | 'pdf-index' | `immigration:${string}`;

export interface ActionContext {
  codeRoot: string;
  dataRoot: string;
  /** The session guard root (CC_GUARD_DIR): each session's guard folder logs the report numbers it reserved itself. */
  guardRoot?: string;
  /** The claude the app runs (CC_CLAUDE_BIN or the resolved one); the daily job gets it when it is absolute, as the plist does. */
  claudeBin?: string;
  /** The node the scheduled jobs are pinned to (pinnedNodeBin); the daily job gets it when it is absolute, as the plist does. */
  nodeBin?: string;
  /** The data root's tracker as path-resolver.mjs rawTrackerPath resolves it (CAREER_OPS_TRACKER first). */
  trackerPath?: string;
  /** Every input file the build writes (tmpFile adds it); the run records them and removes them when it ends. */
  tmpInputs: string[];
  /** The community plugins folder (default <codeRoot>/plugins.local). */
  pluginsLocalDir?: string;
  /** Whether this data root's daily job is running now (however it was started); absent where nothing can tell. */
  dailyRunning?: () => Promise<boolean>;
  /** The live holder of the AI policy pass claim, if any (the daily job runs the same pass). */
  policyPassRunning?: () => { owner: string } | null;
  /** Called once the request has settled (a sync action's run ended); a check that holds something until then adds here. */
  onSettled?: Array<() => void>;
}

/** A check's refusal: a reason (400), or a reason with its own status (409 for a conflict with what is running). */
export type CheckProblem = string | { status: number; error: string };

export interface Command {
  bin: string;
  args: string[];
  cwd: string;
  /** Extra environment for this run only (paths, never secrets). */
  env?: Record<string, string>;
}

export interface ActionDef<S extends z.ZodType = z.ZodType> {
  id: string;
  label: string;
  cost: Cost;
  /**
   * Confirmation text shown before running; undefined means no confirm. The route refuses such an action (428) unless
   * the request says `confirmed: true`, so the browser dialog is not the only gate.
   */
  confirm?: string;
  /** Params that only preview (a dry run), which run without the confirmation. */
  preview?: (params: z.infer<S>) => boolean;
  resources: Resource[];
  claude: boolean;
  /** Sync actions run inline under a 30 s timeout and return their output. */
  sync: boolean;
  /**
   * At most one run of this action from this app at a time: a start while one is queued or running is refused with
   * 409 and this reason. The runner checks and enqueues in one step, so two requests at once cannot both start one.
   */
  single?: (pending: { id: string; status: string }) => string;
  params: S;
  /** A readable reason these params cannot run against the data root (missing input files and the like); checked before build. */
  check?: (params: z.infer<S>, ctx: ActionContext) => CheckProblem | null | Promise<CheckProblem | null>;
  build: (params: z.infer<S>, ctx: ActionContext) => Command;
  /** A background run's exit code that means more than "failed" (a check that found something, a silent refusal). */
  exitMeaning?: ExitMeaning;
  /**
   * A sync check's non-zero exit that means it ran and found problems: the reason to show with its output, answered as
   * 200 instead of a failure. null: a real failure.
   */
  findings?: (r: { code: number; stdout: string; stderr: string }) => string | null;
  /** Exit code to HTTP status for sync actions (default: non-zero is 500). */
  exitMap?: Record<number, number>;
  /** A readable status and message for a failed sync run, replacing the generic "exited N" and the raw stderr. */
  explainFailure?: (run: { code: number; stderr: string }) => { status: number; error: string };
}

export const TRACKER_STATES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'] as const;

type CliId = Parameters<typeof cliScriptPath>[1];
const node = (ctx: ActionContext, id: CliId, args: string[], env?: Record<string, string>): Command => ({
  bin: process.execPath,
  args: [cliScriptPath(ctx.codeRoot, id), ...args],
  cwd: ctx.codeRoot,
  ...(env ? { env } : {}),
});

function define<S extends z.ZodType>(def: ActionDef<S>): ActionDef<S> {
  return def;
}

const flag = (on: boolean | undefined, name: string): string[] => (on ? [name] : []);
const opt = (value: string | number | undefined, name: string): string[] => (value === undefined || value === '' ? [] : [name, String(value)]);
// Free text whose first characters are "--" reads as a missing value to the upstream flag parsers ("--> phone screen").
// set-status has no --note=VALUE form but trims the note it writes, so a leading space carries the text through as is;
// hired-share reads --story=VALUE.
const noteArg = (note: string | undefined): string[] => opt(note?.startsWith('--') ? ` ${note}` : note, '--note');
const storyArg = (story: string | undefined): string[] => (story?.startsWith('--') ? [`--story=${story}`] : opt(story, '--story'));
const none = z.object({});
const dryRun = z.object({ dryRun: z.boolean().default(false) });
const positive = z.number().int().positive();
/**
 * A tracker Report label as written ("012"); hired-share.mjs compares it as text, so "12" would miss "012".
 * A positive number is still accepted (sent as its plain digits) for callers that hold the report as a number.
 */
const reportLabel = z.union([z.string().regex(/^\d{1,6}$/), z.number().int().positive().max(999999)]);
const safeToken = z.string().min(1).max(200).regex(/^[\w.@:,/+=-]+$/, 'letters, digits and . _ - : , / + = @ only');
const relOutput = z.string().regex(/^output\/[\w.-]+$/, 'a file directly under output/');
/** A file under output/ by the rule the Apply page shows too (shared/output-path.ts): any name, one contained file. */
const outputPath = (ext: RegExp, what: string) =>
  z.string().superRefine((p, ctx) => {
    const problem = outputFileProblem(p, ext, what);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });
// The URL goes to a child as an argument (readable in ps) and into its log, so one carrying sign-in details is refused.
const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), 'http(s) only')
  .refine((u) => URL.canParse(u) && !new URL(u).username && !new URL(u).password, 'no user name or password in the link')
  .max(2048);
const company = z.string().min(1).max(200).regex(/^[^\0\r\n]+$/);

/** Ephemeral input files live under the data root, never in the repo, and go when the run ends (tmp-inputs.ts). */
const tmpFile = (ctx: ActionContext, ext: string, content: string): string => {
  const file = writeTmpInput(ctx.dataRoot, ext, content);
  ctx.tmpInputs.push(file);
  return file;
};

/**
 * A finished portal audit's --json output as audit-portals.mjs --baseline reads it. The run log keeps one NDJSON event
 * per output line, and the script pretty-prints its JSON over many lines, so the stdout lines are joined back up.
 */
function auditBaseline(dataRoot: string, runId: string): { json?: string; problem?: string } {
  const store = new RunStore(dataRoot);
  const meta = store.read(runId);
  if (!meta || meta.actionId !== 'portals.audit' || meta.status !== 'done') return { problem: `Run ${runId} is not a finished portal audit, so it cannot be the baseline.` };
  const text = store
    .readRaw(runId)
    .lines.filter((l) => l.stream === 'stdout')
    .map((l) => l.line)
    .join('\n');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed) || (parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows))) return { json: text };
  } catch {
    /* not the --json output */
  }
  return { problem: `Run ${runId} did not print the audit rows as JSON, so it cannot be the baseline.` };
}

/**
 * Report numbers a session manager is reserving, or has reserved but no session record holds yet, per data root.
 * Release report numbers reads the session records to refuse a number a session holds, so it consults this too:
 * a fan-out records its sessions one at a time, and a re-reservation records its number after taking it.
 *
 * Every server process on the data root (blue/green) honours the others' too: each change is written to this
 * process's hold file (reportNumHoldsDir), which a peer reads as long as this process is alive.
 */
export class UnrecordedReservations {
  readonly nums: Set<number>;
  /** Releases that passed the check and have not ended: a reservation waits for them, or one could free what it takes. */
  readonly releasing: Set<Promise<void>>;
  #taking = 0;
  readonly #file: string;

  constructor(dataRoot: string) {
    this.#file = path.join(reportNumHoldsDir(dataRoot), `${process.pid}-${HOLDS_NONCE}.json`);
    // Numbers are added only while taking, whose strict write already holds them all for a peer; each write is the
    // whole state, so the next one that succeeds names them too.
    this.nums = new WatchedSet<number>(() => this.#persist(false));
    // A release a peer cannot see could free a number the peer is about to take, so it is refused unless written.
    this.releasing = new WatchedSet<Promise<void>>((op) => this.#persist(op === 'add'));
  }

  get taking(): number {
    return this.#taking;
  }

  set taking(value: number) {
    const before = this.#taking;
    this.#taking = value;
    try {
      this.#persist(value > before);
    } catch (err) {
      this.#taking = before;
      throw err;
    }
  }

  get file(): string {
    return this.#file;
  }

  /**
   * Writes this process's holds, or removes the file once nothing is held. A hold being added fails loudly when it
   * cannot be written (strict), so nothing is reserved or released that a peer cannot see; a hold being dropped only
   * warns, since a file left behind holds more, never less.
   */
  #persist(strict: boolean): void {
    try {
      if (this.#taking <= 0 && this.nums.size === 0 && this.releasing.size === 0) {
        fs.rmSync(this.#file, { force: true });
        return;
      }
      if (typeof ownStart !== 'number') ownStart = processStartTime(process.pid);
      const hold: ReportNumHold = { pid: process.pid, start: ownStart, at: Date.now(), nonce: HOLDS_NONCE, taking: this.#taking > 0, releasing: this.releasing.size > 0, nums: [...this.nums] };
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(hold));
        fs.renameSync(tmp, this.#file);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
    } catch (err) {
      if (strict) throw new Error(`Could not record the report-number hold in ${this.#file}: ${(err as Error).message}`, { cause: err });
      console.warn(`[actions] could not update the report-number hold in ${this.#file}: ${(err as Error).message}`);
    }
  }
}

/** A Set that reports each change it makes, after making it; a change whose report throws is undone. */
class WatchedSet<T> extends Set<T> {
  readonly #changed: (op: 'add' | 'delete') => void;

  constructor(changed: (op: 'add' | 'delete') => void) {
    super();
    this.#changed = changed;
  }

  override add(value: T): this {
    if (this.has(value)) return this;
    super.add(value);
    try {
      this.#changed('add');
    } catch (err) {
      super.delete(value);
      throw err;
    }
    return this;
  }

  override delete(value: T): boolean {
    if (!super.delete(value)) return false;
    this.#changed('delete');
    return true;
  }

  override clear(): void {
    if (this.size === 0) return;
    super.clear();
    this.#changed('delete');
  }
}

interface ReportNumHold {
  pid: number;
  start: ProcessStart;
  at: number;
  nonce: string;
  taking: boolean;
  releasing: boolean;
  nums: number[];
}

const HOLDS_NONCE = crypto.randomUUID();
let ownStart: ProcessStart | undefined;
const unrecordedReservations = new Map<string, UnrecordedReservations>();

/** Where every server process on the data root keeps its report-number holds, one file per process. */
export function reportNumHoldsDir(dataRoot: string): string {
  return path.join(path.dirname(sessionsDir(dataRoot)), 'report-num-holds');
}

export function unrecordedFor(dataRoot: string): UnrecordedReservations {
  const key = path.resolve(dataRoot);
  let entry = unrecordedReservations.get(key);
  if (!entry) unrecordedReservations.set(key, (entry = new UnrecordedReservations(key)));
  return entry;
}

/**
 * What the other live server processes on the data root hold. A hold file that cannot be read, from a process still
 * alive, might hold anything, so it counts as taking and releasing both. A dead holder's file is removed.
 */
function peerHolds(dataRoot: string): { taking: boolean; releasing: boolean; nums: number[] } {
  const own = unrecordedFor(dataRoot).file;
  const dir = reportNumHoldsDir(dataRoot);
  const out = { taking: false, releasing: false, nums: [] as number[] };
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    if (!name.endsWith('.json') || file === own) continue;
    const text = readOrNull(file);
    if (text === null) continue;
    if (turnClaimGone(file, text)) {
      removeIf(file, text);
      continue;
    }
    let hold: Partial<ReportNumHold>;
    try {
      hold = JSON.parse(text) as Partial<ReportNumHold>;
    } catch {
      hold = {};
    }
    if (typeof hold.taking !== 'boolean' || typeof hold.releasing !== 'boolean' || !Array.isArray(hold.nums)) {
      out.taking = out.releasing = true;
      continue;
    }
    out.taking ||= hold.taking;
    out.releasing ||= hold.releasing;
    out.nums.push(...hold.nums.filter((n): n is number => Number.isInteger(n)));
  }
  return out;
}

const PEER_RELEASE_POLL_MS = 50;

/**
 * Marks a reservation as being taken and waits until no release is running here or in a peer process (a forced
 * release removes whatever sentinel it finds). Marked before the wait, so a release asked for meanwhile is refused
 * instead of passing it: a release marks itself before it reads the reservations, so one of the two sees the other.
 */
export async function beginTakingReportNums(dataRoot: string): Promise<UnrecordedReservations> {
  const entry = unrecordedFor(dataRoot);
  entry.taking += 1;
  try {
    for (;;) {
      if (entry.releasing.size > 0) await Promise.all(entry.releasing);
      else if (peerHolds(dataRoot).releasing) await new Promise((r) => setTimeout(r, PEER_RELEASE_POLL_MS));
      else return entry;
    }
  } catch (err) {
    entry.taking -= 1;
    throw err;
  }
}

/**
 * Whether a reservation is being taken now (its numbers unknown until it returns), and the numbers taken but not yet
 * recorded, by this process or a peer on the data root.
 */
function unrecordedReportNums(dataRoot: string): { taking: boolean; nums: number[] } {
  const entry = unrecordedReservations.get(path.resolve(dataRoot));
  const peers = peerHolds(dataRoot);
  return { taking: (entry?.taking ?? 0) > 0 || peers.taking, nums: [...(entry ? [...entry.nums] : []), ...peers.nums] };
}

/**
 * The reserved report numbers this data root's sessions hold: the one the app reserved for a session (it keeps it until
 * its turn settles and clears it) and the ones its own reserve-report-num.mjs runs printed, logged in its guard folder.
 * Or the session that cannot be read: that one might hold any number.
 */
function heldReportNums(dataRoot: string, guardRoot: string): { held: Array<{ num: number; sessionId: string }> } | { unreadable: string; why: string } {
  const store = new SessionStore(dataRoot, guardRoot);
  const held: Array<{ num: number; sessionId: string }> = [];
  for (const entry of fs.readdirSync(sessionsDir(dataRoot), { withFileTypes: true })) {
    // Only session folders, as SessionStore.list takes them.
    if (!entry.isDirectory() || !/^[\w-]+$/.test(entry.name)) continue;
    try {
      const meta = store.read(entry.name);
      if (meta && meta.reportNum !== null) held.push({ num: meta.reportNum, sessionId: meta.id });
      // A guard folder outlives no session: delete removes it, so a log here is a session's (meta torn or not).
      for (const num of heldReportNumsOf(store.guardDirOf(entry.name), dataRoot)) held.push({ num, sessionId: meta?.id ?? entry.name });
    } catch (err) {
      return { unreadable: entry.name, why: (err as Error).message };
    }
  }
  return { held };
}

/** Why releasing report numbers first..last could free a number a session holds or is about to, or null. */
function releaseProblem(ctx: ActionContext, first: number, last: number): CheckProblem | null {
  // A Batch evaluate or a reply taking a fresh number holds it before any session record says so.
  const unrecorded = unrecordedReportNums(ctx.dataRoot);
  if (unrecorded.taking) return { status: 409, error: 'A session is reserving report numbers right now, so one of these may be about to be its own. Nothing was released; try again in a moment.' };
  const starting = [...new Set(unrecorded.nums.filter((n) => n >= first && n <= last))];
  if (starting.length > 0) return { status: 409, error: `Report ${starting.join(', ')} is reserved for a session that is starting. Nothing was released; it releases its own number.` };
  // Without the guard root the numbers sessions reserved themselves cannot be read, so any might be held.
  if (!ctx.guardRoot) return { status: 409, error: 'The session guard folder is not known here, so a session may hold one of these numbers. Nothing was released.' };
  const sessions = heldReportNums(ctx.dataRoot, ctx.guardRoot);
  if ('unreadable' in sessions) return { status: 409, error: `Session ${sessions.unreadable} cannot be read (${sessions.why}), so it may hold one of these numbers. Nothing was released.` };
  const held = sessions.held.filter((h) => h.num >= first && h.num <= last);
  if (held.length === 0) return null;
  return { status: 409, error: `Report ${held.map((h) => `${h.num} is held by session ${h.sessionId}`).join(', ')}. Cancel it if it is running, or delete it if it has ended; either releases its number.` };
}

const RUN_DAILY = 'custom/immigration/run-daily.sh';
const CONTACTS_VCF = 'custom/control-center/server/actions/contacts-vcf.mjs';
const PLUGIN_AUDIT_ALL = 'custom/control-center/server/actions/plugin-audit-all.mjs';

interface DeleteParse {
  resolveColumns: (lines: string[]) => Record<string, number>;
  parseTrackerRow: (line: string, colmap: Record<string, number>) => (Record<string, string> & { num: number }) | null;
  extractTrackerReportLinks: (reportCell: string, notesCell?: string) => Array<{ target: number; label: number | null }>;
}

/**
 * The rows tracker.mjs delete --num n removes, matched as its removeRowByNum does (a trimmed table line whose number
 * cell is exactly n), each as the page shows it, or null for one too malformed to parse.
 */
async function rowsDeletedUnder(ctx: ActionContext, n: number): Promise<{ rows: Array<RowIdentity | null>; respelled: string | null }> {
  const [tp, file] = await Promise.all([importCore<DeleteParse>(ctx.codeRoot, 'tracker-parse.mjs'), resolveTrackerFile(ctx.codeRoot, ctx.dataRoot)]);
  let text: string;
  try {
    text = fs.readFileSync(file.canonical, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], respelled: null };
    throw err;
  }
  const lines = text.split('\n').map((l) => l.trim());
  const colmap = tp.resolveColumns(lines);
  const numCell = (l: string) => (l.startsWith('|') ? (l.split('|').map((c) => c.trim())[colmap.num!] ?? '') : '');
  const rows = lines
    .filter((l) => numCell(l) === String(n))
    .map((l) => {
      const raw = tp.parseTrackerRow(l, colmap);
      return raw ? { company: raw.company ?? '', role: raw.role ?? '', report: tp.extractTrackerReportLinks(raw.report ?? '', raw.notes ?? '')[0]?.target ?? null } : null;
    });
  // The page reads a number cell as parseInt does, so it can show a row written "024" as #24, which this delete skips.
  const respelled = lines.map(numCell).find((c) => c !== String(n) && parseInt(c, 10) === n) ?? null;
  return { rows, respelled };
}

/** The rows set-status.mjs --row n chooses from: every parseable line whose number reads as n, as the page shows it. */
export async function rowsSetUnder(ctx: Pick<ActionContext, 'codeRoot' | 'dataRoot'>, n: number): Promise<RowIdentity[]> {
  const [tp, file] = await Promise.all([importCore<DeleteParse>(ctx.codeRoot, 'tracker-parse.mjs'), resolveTrackerFile(ctx.codeRoot, ctx.dataRoot)]);
  let text: string;
  try {
    text = fs.readFileSync(file.canonical, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const lines = text.split('\n');
  const colmap = tp.resolveColumns(lines);
  return lines
    .map((l) => tp.parseTrackerRow(l, colmap))
    .filter((raw) => raw !== null && raw.num === n)
    .map((raw) => ({ company: raw!.company ?? '', role: raw!.role ?? '', report: tp.extractTrackerReportLinks(raw!.report ?? '', raw!.notes ?? '')[0]?.target ?? null }));
}

type RowIdentity = { company: string; role: string; report: number | null };
type ExpectedRow = { expectCompany?: string; expectRole?: string; expectReport?: number | null };
const expectsRow = (p: ExpectedRow) => p.expectCompany !== undefined || p.expectRole !== undefined || p.expectReport !== undefined;
const isExpectedRow = (p: ExpectedRow) => (r: RowIdentity | null) =>
  r !== null && (p.expectCompany === undefined || r.company === p.expectCompany) && (p.expectRole === undefined || r.role === p.expectRole) && (p.expectReport === undefined || r.report === p.expectReport);
// expectCompany/expectRole/expectReport: the row the page showed under that number. Scalars, so the palette's params
// dialog can ask for them too.
const expectedRowParams = {
  // Uncapped: they echo a hand-editable tracker cell, and the request body limit already bounds them.
  expectCompany: z.string().trim().optional(),
  expectRole: z.string().trim().optional(),
  // The palette types a nullable number as text, so a typed report number is read as the number.
  expectReport: z.preprocess((v) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v), positive.nullable()).optional(),
};

export const ACTIONS: ActionDef[] = [
  // ---- tracker ----
  define({
    id: 'tracker.setStatus',
    label: 'Set application status',
    cost: 'free',
    resources: ['tracker'],
    claude: false,
    sync: true,
    // A delete reindexes the tracker, so a page's row number can name another application by the time it is clicked:
    // a status naming a row that is no longer under that number is refused rather than set on an unseen one.
    params: z.object({ row: positive, state: z.enum(TRACKER_STATES), note: z.string().max(STATUS_NOTE_MAX).optional(), on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), ...expectedRowParams }),
    check: async (p, ctx) => {
      if (!expectsRow(p)) return null;
      const rows = await rowsSetUnder(ctx, p.row);
      if (rows.length === 0) return { status: 409, error: `Row #${p.row} no longer exists. Reload the tracker.` };
      // Several rows under one number: set-status.mjs refuses that itself, naming them.
      if (rows.length > 1 || isExpectedRow(p)(rows[0]!)) return null;
      return { status: 409, error: `Row #${p.row} now holds ${rows[0]!.company} (${rows[0]!.role}), not the row you picked. Reload the tracker.` };
    },
    build: (p, ctx) => node(ctx, 'setStatus', ['--row', String(p.row), p.state, '--source', 'web', '--json', ...noteArg(p.note), ...opt(p.on, '--on')]),
    exitMap: { 1: 400, 2: 404, 3: 409, 4: 503 },
  }),
  define({
    id: 'tracker.delete',
    label: 'Delete tracker row',
    cost: 'free',
    confirm: 'Removes the row from applications.md and reindexes. The report file stays on disk as an orphan. Continue?',
    resources: ['tracker'],
    claude: false,
    sync: true,
    // The expected row is the one the page previewed. A number freed by a delete can be reused by a later merge, so a
    // confirm naming a row that is no longer under n is refused rather than deleting an unseen one.
    params: z.object({ n: positive, dryRun: z.boolean().default(false), ...expectedRowParams }),
    preview: (p) => p.dryRun,
    check: async (p, ctx) => {
      if (p.dryRun || !expectsRow(p)) return null;
      const { rows, respelled } = await rowsDeletedUnder(ctx, p.n);
      const matches = isExpectedRow(p);
      // tracker.mjs deletes every row numbered n, so each of them must be the previewed one.
      const other = rows.find((r) => !matches(r));
      if (other === undefined) return null;
      const named = other === null ? 'a row this page cannot read' : `${other.company} (${other.role})`;
      if (respelled !== null) return { status: 409, error: `Row #${p.n} is also written "${respelled}" in applications.md, and this delete would remove ${named} instead of that row. Fix the number cell there first.` };
      // The page previews one row, so a number shared with a matching row stays refused however often it is previewed.
      if (rows.some(matches)) return { status: 409, error: `Row #${p.n} numbers more than one row (also ${named}), and deleting it would remove them all. Renumber the duplicate in applications.md (or run Deduplicate tracker) first.` };
      return { status: 409, error: `Row #${p.n} now holds ${named}, not only the row you previewed. Preview the delete again.` };
    },
    build: (p, ctx) => node(ctx, 'tracker', ['delete', '--num', String(p.n), ...flag(p.dryRun, '--dry-run')]),
  }),
  define({ id: 'tracker.verify', label: 'Verify tracker and pipeline', cost: 'free', resources: [], claude: false, sync: false, params: none, build: (_p, ctx) => node(ctx, 'verifyPipeline', []) }),
  define({ id: 'tracker.normalize', label: 'Normalize statuses', cost: 'free', resources: ['tracker'], claude: false, sync: false, params: dryRun, build: (p, ctx) => node(ctx, 'normalizeStatuses', flag(p.dryRun, '--dry-run')) }),
  define({ id: 'tracker.dedup', label: 'Deduplicate tracker', cost: 'free', resources: ['tracker'], claude: false, sync: false, params: dryRun, build: (p, ctx) => node(ctx, 'dedupTracker', flag(p.dryRun, '--dry-run')) }),
  define({
    id: 'tracker.merge',
    label: 'Merge tracker additions',
    cost: 'free',
    resources: ['tracker'],
    claude: false,
    sync: false,
    params: z.object({ dryRun: z.boolean().default(false), verify: z.boolean().default(false) }),
    build: (p, ctx) => node(ctx, 'mergeTracker', [...flag(p.dryRun, '--dry-run'), ...flag(p.verify, '--verify')]),
  }),
  // merge-tracker.mjs --backfill-urls fills the URL column and exits before any merge or --verify, so it is its own action.
  define({ id: 'tracker.backfillUrls', label: 'Backfill tracker URLs from reports', cost: 'free', resources: ['tracker'], claude: false, sync: false, params: dryRun, build: (p, ctx) => node(ctx, 'mergeTracker', ['--backfill-urls', ...flag(p.dryRun, '--dry-run')]) }),
  define({ id: 'tracker.reconcile', label: 'Reconcile pipeline with tracker', cost: 'free', resources: ['tracker', 'pipeline'], claude: false, sync: false, params: dryRun, build: (p, ctx) => node(ctx, 'reconcilePipeline', flag(p.dryRun, '--dry-run')) }),
  define({
    id: 'tracker.syncCheck',
    label: 'Tracker sync check',
    cost: 'free',
    resources: [],
    claude: false,
    sync: true,
    params: none,
    build: (_p, ctx) => node(ctx, 'tracker', ['sync', '--check']),
    // tracker.mjs sync --check exits 1 when its diagnosis found issues, after its closing "(--check" line; any other
    // exit 1 (no tracker, no node:sqlite) is a failure.
    findings: (r) => (r.code === 1 && r.stderr.includes('(--check') ? 'The tracker sync check found problems; see its output.' : null),
  }),
  define({
    id: 'tracker.hiredShare',
    label: 'Draft Hired Wall story',
    cost: 'free',
    resources: [],
    claude: false,
    sync: true,
    params: z.object({ report: reportLabel, anonymity: z.enum(['handle', 'role', 'count']), story: z.string().max(2000).optional() }),
    build: (p, ctx) => node(ctx, 'hiredShare', ['--report', String(p.report), '--anonymity', p.anonymity, ...storyArg(p.story)]),
  }),
  define({
    id: 'tracker.hiredMark',
    label: 'Record the Hired Wall answer',
    cost: 'free',
    resources: [],
    claude: false,
    sync: true,
    params: z.object({ report: reportLabel, mark: z.enum(['shared', 'later', 'never']) }),
    build: (p, ctx) => node(ctx, 'hiredShare', ['--report', String(p.report), '--mark', p.mark]),
  }),
  // Read-only: the hires the AGENTS.md cadence still allows asking (never asked, or "later" over 30 days ago).
  define({ id: 'tracker.hiredStatus', label: 'Hired Wall ask status', cost: 'free', resources: [], claude: false, sync: true, params: none, build: (_p, ctx) => node(ctx, 'hiredShare', ['--status']) }),
  // ---- pipeline ----
  define({ id: 'pipeline.prioritize', label: 'Prioritize pipeline', cost: 'free', resources: ['pipeline'], claude: false, sync: false, params: none, build: (_p, ctx) => node(ctx, 'prioritize', []) }),
  define({
    id: 'pipeline.rank',
    label: 'Rank pipeline',
    cost: 'tokens',
    resources: ['pipeline'],
    claude: true,
    sync: false,
    params: z.object({ limit: positive.max(200).default(50), model: safeToken.optional(), dryRun: z.boolean().default(false) }),
    build: (p, ctx) => node(ctx, 'rankPipeline', ['--limit', String(p.limit), ...opt(p.model, '--model'), ...flag(p.dryRun, '--dry-run')]),
  }),
  define({
    id: 'pipeline.shortlist',
    label: 'Rebuild shortlist',
    cost: 'free',
    resources: ['pipeline'],
    claude: false,
    sync: false,
    params: z.object({ minRank: z.number().min(0).max(5).optional(), top: positive.max(500).optional() }),
    build: (p, ctx) => node(ctx, 'shortlist', [...opt(p.minRank, '--min-rank'), ...opt(p.top, '--top')]),
  }),
  define({ id: 'pipeline.reserveReportNums', label: 'Reserve report numbers', cost: 'free', resources: ['tracker'], claude: false, sync: true, params: z.object({ count: positive.max(50) }), build: (p, ctx) => node(ctx, 'reserveReportNum', ['--count', String(p.count)]) }),
  define({
    id: 'pipeline.releaseReportNums',
    label: 'Release report numbers',
    cost: 'free',
    resources: ['tracker'],
    claude: false,
    sync: true,
    params: z.object({ range: z.string().regex(/^\d+(-\d+)?$/, 'one number (12) or one range (12-14), as reserve-report-num.mjs --release takes') }),
    // reserve-report-num.mjs --release removes a sentinel whoever owns it, so a number a session was told is reserved
    // (Batch evaluate, or one awaiting a reply) would be handed out again: refused while any session holds it.
    check: (p, ctx) => {
      const [first, last] = p.range.includes('-') ? p.range.split('-').map(Number) : [Number(p.range), Number(p.range)];
      // Marked running before the reservations are read: a peer process marks its reservation before it reads the
      // releases, so of a release and a reservation starting at once, one sees the other. Until the release has run,
      // a reservation waits rather than take a number it is about to remove.
      const entry = unrecordedFor(ctx.dataRoot);
      let ended!: () => void;
      const releasing = new Promise<void>((resolve) => (ended = resolve));
      const end = () => {
        entry.releasing.delete(releasing);
        ended();
      };
      try {
        entry.releasing.add(releasing);
      } catch (err) {
        return { status: 409, error: `${(err as Error).message}. Nothing was released.` };
      }
      let problem: CheckProblem | null;
      try {
        problem = releaseProblem(ctx, first!, last!);
      } catch (err) {
        end();
        throw err;
      }
      if (problem) end();
      else (ctx.onSettled ??= []).push(end);
      return problem;
    },
    build: (p, ctx) => node(ctx, 'reserveReportNum', ['--release', p.range]),
  }),
  // Batch evaluation is not an action: batch/batch-runner.sh runs its workers outside any guard, so Pipeline > Batch
  // starts one confined session per URL through POST /api/sessions/fanout instead.
  // ---- scan ----
  define({
    id: 'scan.portals',
    label: 'Scan portals',
    cost: 'network',
    resources: ['pipeline'],
    claude: false,
    sync: false,
    params: z.object({ verify: z.boolean().default(false), includeBlacklisted: z.boolean().default(false) }),
    build: (p, ctx) => node(ctx, 'scan', [...flag(p.verify, '--verify'), ...flag(p.includeBlacklisted, '--include-blacklisted')]),
  }),
  define({
    id: 'scan.network',
    label: 'Network scan (dry run)',
    cost: 'network',
    resources: [],
    claude: false,
    sync: false,
    params: z.object({
      roles: z.array(z.string().max(100)).max(30).default([]),
      exclude: z.array(z.string().max(100)).max(30).default([]),
      locationAllow: z.array(z.string().max(100)).max(30).default([]),
      block: z.array(z.string().max(100)).max(30).default([]),
      sinceDays: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(14), z.literal(30)]).default(7),
      ats: z.array(z.enum(NETWORK_SCAN_SOURCES)).min(1).max(10),
      limit: positive.min(50).max(500).default(100),
      seeds: safeToken.optional(),
      includeUndated: z.boolean().default(false),
    }),
    build: (p, ctx) => {
      const portals = YAML.stringify({
        title_filter: { positive: p.roles, negative: p.exclude },
        location_filter: { strict: false, allow: p.locationAllow, block: p.block },
        tracked_companies: [],
        job_boards: [],
        search_queries: [],
      });
      const file = tmpFile(ctx, 'yml', `# Ephemeral filters for one network scan\n${portals}`);
      return node(ctx, 'scanAtsFull', ['--dry-run', '--json', '--since', String(p.sinceDays), '--ats', p.ats.join(','), '--limit', String(p.limit), ...opt(p.seeds, '--seeds'), ...flag(p.includeUndated, '--include-undated')], { CAREER_OPS_PORTALS: file });
    },
  }),
  define({
    id: 'scan.full',
    label: 'Full ATS scan',
    cost: 'network',
    resources: ['pipeline'],
    claude: false,
    sync: false,
    params: z.object({ since: positive.max(90).optional(), ats: z.array(safeToken).max(10).default([]), limit: positive.max(500).optional(), dryRun: z.boolean().default(false), liveness: z.boolean().default(false), includeUndated: z.boolean().default(false) }),
    build: (p, ctx) => node(ctx, 'scanAtsFull', [...opt(p.since, '--since'), ...(p.ats.length ? ['--ats', p.ats.join(',')] : []), ...opt(p.limit, '--limit'), ...flag(p.dryRun, '--dry-run'), ...flag(p.liveness, '--liveness'), ...flag(p.includeUndated, '--include-undated')]),
  }),
  define({ id: 'scan.seeds', label: 'Scan VC portfolio seeds', cost: 'network', resources: ['pipeline'], claude: false, sync: false, params: z.object({ list: safeToken }), build: (p, ctx) => node(ctx, 'scanAtsFull', ['--seeds', p.list]) }),
  define({ id: 'scan.hn', label: 'Scan Hacker News hiring', cost: 'network', resources: ['pipeline'], claude: false, sync: false, params: none, build: (_p, ctx) => node(ctx, 'scanHn', []) }),
  define({ id: 'scan.interamt', label: 'Scan Interamt', cost: 'network', resources: ['pipeline'], claude: false, sync: false, params: none, build: (_p, ctx) => node(ctx, 'scanInteramt', []) }),
  define({
    id: 'scan.funded',
    label: 'Recently funded companies',
    cost: 'network',
    resources: [],
    claude: false,
    sync: false,
    params: z.object({ months: positive.max(36).default(6), sort: z.enum(['date', 'score']).optional(), sources: safeToken.optional() }),
    build: (p, ctx) => node(ctx, 'companyFunded', ['--dry-run', '--json', '--months', String(p.months), ...opt(p.sort, '--sort'), ...opt(p.sources, '--sources')]),
  }),
  define({ id: 'scan.reposts', label: 'Detect reposts', cost: 'free', resources: [], claude: false, sync: false, params: none, build: (_p, ctx) => node(ctx, 'detectReposts', ['--summary']) }),
  // ---- portals ----
  define({ id: 'portals.validate', label: 'Validate portals.yml', cost: 'free', resources: [], claude: false, sync: true, params: none, build: (_p, ctx) => node(ctx, 'validatePortals', []) }),
  define({ id: 'portals.verify', label: 'Verify portal slugs', cost: 'network', resources: ['portals'], claude: false, sync: false, params: none, build: (_p, ctx) => node(ctx, 'verifyPortals', []) }),
  define({
    id: 'portals.audit',
    label: 'Audit portals',
    cost: 'network',
    resources: [],
    claude: false,
    sync: false,
    params: z.object({ company: company.optional(), smallThreshold: positive.max(1000).optional(), baselineRunId: z.string().regex(/^[\w-]+$/).optional() }),
    check: (p, ctx) => (p.baselineRunId ? (auditBaseline(ctx.dataRoot, p.baselineRunId).problem ?? null) : null),
    build: (p, ctx) => {
      const baseline = p.baselineRunId ? auditBaseline(ctx.dataRoot, p.baselineRunId).json : undefined;
      return node(ctx, 'auditPortals', ['--json', ...opt(p.company, '--company'), ...opt(p.smallThreshold, '--small-threshold'), ...(baseline ? ['--baseline', tmpFile(ctx, 'json', baseline)] : [])]);
    },
  }),
  define({
    id: 'portals.fixSlugs',
    label: 'Fix portal slugs',
    cost: 'network',
    confirm: 'Rewrites broken slugs in portals.yml. Run the dry run first. Continue?',
    resources: ['portals'],
    claude: false,
    sync: false,
    params: z.object({ apply: z.boolean().default(false) }),
    preview: (p) => !p.apply,
    build: (p, ctx) => node(ctx, 'fixSlugs', p.apply ? ['--apply'] : ['--dry-run']),
  }),
  // ---- immigration ----
  define({
    id: 'immigration.watch',
    label: 'Check official feeds',
    cost: 'network',
    resources: ['immigration:policy'],
    claude: false,
    sync: false,
    // A second check would only queue behind the first on immigration:policy and fetch the same feeds again. single
    // sees only the pending run, not this request's since, so a backfill is refused too and the message says so.
    single: (mine) => `Skipped: a feed check is already ${mine.status === 'queued' ? 'queued' : 'running'} from here (run ${mine.id}). A check with a since date is refused too: run it again once that one ends. Watch it on Runs & Schedule.`,
    params: z.object({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    build: (p, ctx) => node(ctx, 'immigrationWatch', opt(p.since, '--since')),
  }),
  define({ id: 'immigration.freshness', label: 'Company check freshness', cost: 'free', resources: [], claude: false, sync: true, params: z.object({ company }), build: (p, ctx) => node(ctx, 'freshness', [p.company]) }),
  define({
    id: 'immigration.h1b',
    label: 'H-1B sponsor lookup',
    cost: 'network',
    resources: [],
    claude: false,
    sync: true,
    params: z.object({ company, mode: z.enum(['summary', 'json', 'search']).default('summary') }),
    build: (p, ctx) => node(ctx, 'h1bCheck', p.mode === 'search' ? ['--search', p.company] : [p.company, `--${p.mode}`]),
  }),
  // ---- documents ----
  define({
    id: 'docs.renderPdf',
    label: 'Re-render PDF from HTML',
    cost: 'free',
    // generate-pdf.mjs rewrites pdf-index.tsv without a lock, so this and docs.coverPdf share a resource: two at once would drop one's row.
    resources: ['pdf-index'],
    claude: false,
    sync: false,
    // generate-pdf.mjs files the PDF in pdf-index.tsv under --report, so it must be the row's report, never the row number.
    params: z.object({ row: positive, report: positive, html: outputPath(/\.html$/i, 'an .html file'), pdf: outputPath(/\.pdf$/i, 'a .pdf file'), format: z.enum(['letter', 'a4']).optional() }),
    check: async (p, ctx) => {
      const tracker = await readTracker(ctx.codeRoot, ctx.dataRoot);
      const row = tracker.kind === 'ok' ? tracker.rows.find((r) => r.num === p.row) : undefined;
      if (!row) return `There is no tracker row #${p.row}.`;
      if (row.report === null) return `Row #${p.row} has no evaluation report, so a re-rendered PDF has nowhere to be filed.`;
      if (row.report !== p.report) return `Row #${p.row} is filed under report ${row.report}, not report ${p.report}. Reload the Documents tab and try again.`;
      return rerenderProblem(await readPdfIndex(ctx.codeRoot, ctx.dataRoot), p.report, p.html, p.pdf);
    },
    // No format: generate-pdf.mjs takes the profile's page_format, which an explicit --format would override.
    build: (p, ctx) => node(ctx, 'generatePdf', [path.join(ctx.dataRoot, p.html), path.join(ctx.dataRoot, p.pdf), ...(p.format ? [`--format=${p.format}`] : []), `--report=${p.report}`]),
  }),
  define({
    id: 'projects.rank',
    label: 'Rank library projects against a JD',
    cost: 'free',
    resources: [],
    claude: false,
    sync: true,
    params: z.object({ text: z.string().min(1).max(100_000) }),
    build: (p, ctx) => node(ctx, 'rankProjects', [tmpFile(ctx, 'md', p.text), '--json']),
    exitMap: { 1: 422 },
  }),
  define({ id: 'docs.coverPdf', label: 'Render cover letter PDF', cost: 'free', resources: ['pdf-index'], claude: false, sync: false, params: z.object({ payloadPath: relOutput }), build: (p, ctx) => node(ctx, 'generateCoverLetter', ['--payload', path.join(ctx.dataRoot, p.payloadPath)]) }),
  define({
    id: 'docs.archivePosting',
    label: 'Archive posting',
    cost: 'network',
    resources: [],
    claude: false,
    sync: false,
    // archive-posting.mjs files the capture as jds/NNN-... under --report, which jd-capture.mjs and outcome.mjs read by
    // report number: the field is the report, named so (a row number would file it under another application).
    params: z.object({ report: positive, url: httpUrl }),
    check: (p, ctx) => (listReportFiles(ctx.dataRoot).has(p.report) ? null : `There is no file for report ${p.report} under reports/.`),
    build: (p, ctx) => node(ctx, 'archivePosting', [p.url, '--report', String(p.report)]),
  }),
  define({
    id: 'docs.liveness',
    label: 'Check posting liveness',
    cost: 'network',
    resources: [],
    claude: false,
    sync: false,
    params: z.object({ urls: z.array(httpUrl).min(1).max(200) }),
    build: (p, ctx) => node(ctx, 'checkLiveness', ['--file', tmpFile(ctx, 'txt', p.urls.join('\n') + '\n')]),
    // check-liveness.mjs exits 1 when a posting is expired or uncertain: the check is done, its log says which.
    exitMeaning: { code: 1, status: 'done', onlyWithoutStderr: true },
  }),
  define({
    id: 'docs.fetchJd',
    label: 'Fetch job description',
    cost: 'network',
    resources: [],
    claude: false,
    sync: false,
    params: z.object({ url: httpUrl }),
    build: (p, ctx) => node(ctx, 'fetchJd', [p.url]),
    // fetch-jd.mjs exits 1 without a word when no job-board API it knows covers the URL (by design: callers fall back).
    exitMeaning: { code: 1, status: 'failed', onlyWithoutStderr: true, error: 'No job-board API that fetch-jd.mjs knows covers this URL. Open the posting in the browser and copy the description instead.' },
  }),
  define({
    id: 'docs.prepareApplication',
    label: 'Prepare application (zero-token prefill)',
    cost: 'network',
    resources: [],
    claude: false,
    sync: true,
    params: z.object({ url: httpUrl, pdf: outputPath(/\.pdf$/i, 'a .pdf file'), cover: outputPath(/\.(txt|md)$/i, 'a .txt or .md file').optional() }),
    check: (p, ctx) => {
      const problem = prefillUrlProblem(p.url);
      if (problem) return problem;
      if (!resolveOutputFile(ctx.dataRoot, p.pdf)) return `The CV PDF ${p.pdf} does not exist. Generate the tailored CV first or choose another PDF.`;
      if (p.cover && !resolveOutputFile(ctx.dataRoot, p.cover)) return `The cover letter ${p.cover} does not exist. Choose another or leave it out.`;
      return null;
    },
    // The script resolves both paths against CAREER_OPS_ROOT and requires the PDF under output/.
    build: (p, ctx) => node(ctx, 'prepareApplication', ['--url', p.url, '--pdf', p.pdf, ...opt(p.cover, '--cover')]),
    explainFailure: ({ code, stderr }) => {
      const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
      const reasons = lines.filter((l) => l.startsWith('Error:')).map((l) => l.slice('Error:'.length).trim());
      if (reasons.length) return { status: 422, error: `Prefill could not run: ${reasons.join(' ')}` };
      return { status: 502, error: `Prefill failed: prepare-application.mjs exited ${code} (last output: ${lines.at(-1) ?? 'none'}).` };
    },
  }),
  // Initialize application artifacts is not an action: application-artifacts.mjs keys the bundle by the report's company
  // and role text, which the pdf mode passes from the row it tailors; typed by hand they would name another folder.
  define({
    id: 'docs.imgToPdf',
    label: 'Image to PDF',
    cost: 'free',
    resources: [],
    claude: false,
    sync: false,
    params: z.object({ file: outputPath(/\.(png|jpe?g|gif|webp|bmp|svg)$/i, 'a png, jpg, gif, webp, bmp or svg image'), pdf: outputPath(/\.pdf$/i, 'a .pdf file'), force: z.boolean().default(false) }),
    check: (p, ctx) => {
      if (!resolveOutputFile(ctx.dataRoot, p.file)) return `The image ${p.file} does not exist.`;
      // img-to-pdf.mjs writes wherever the path leads: a symlinked PDF or folder under output/ must not take it out.
      try {
        containedTarget(path.join(ctx.dataRoot, p.pdf), { within: [{ root: path.join(ctx.dataRoot, 'output'), name: 'output folder' }] });
        return null;
      } catch (err) {
        if (err instanceof OutsideRootsError) return err.message;
        throw err;
      }
    },
    // img-to-pdf.mjs <image-path> <output-path> [--force]: without --force it refuses to replace an existing PDF.
    build: (p, ctx) => node(ctx, 'imgToPdf', [path.join(ctx.dataRoot, p.file), path.join(ctx.dataRoot, p.pdf), ...flag(p.force, '--force')]),
  }),
  // ---- insights ----
  define({ id: 'insights.stats', label: 'Stats', cost: 'free', resources: [], claude: false, sync: true, params: none, build: (_p, ctx) => node(ctx, 'stats', []) }),
  ...(
    [
      ['insights.funnelVelocity', 'Funnel velocity', 'funnelVelocity'],
      ['insights.analyzePatterns', 'Analyze patterns', 'analyzePatterns'],
      ['insights.salaryGap', 'Salary gap', 'salaryGap'],
      ['insights.upskill', 'Upskill suggestions', 'upskill'],
      ['insights.rejectionLatency', 'Rejection latency', 'rejectionLatency'],
      ['insights.processQuality', 'Process quality', 'processQuality'],
      ['insights.weeklyDigest', 'Weekly digest', 'weeklyDigest'],
      ['insights.assessmentLog', 'Assessment log', 'assessmentLog'],
      ['insights.storyProvenance', 'Story provenance check', 'storyProvenanceCheck'],
      ['insights.contacts', 'Contacts summary', 'contacts'],
    ] as Array<[string, string, CliId]>
  ).map(([id, label, cli]) => define({ id, label, cost: 'free', resources: [], claude: false, sync: false, params: none, build: (_p, ctx) => node(ctx, cli, ['--summary']) })),
  define({
    id: 'insights.companyHistory',
    label: 'Company history',
    cost: 'free',
    resources: [],
    claude: false,
    sync: false,
    params: z.object({ company: company.optional() }),
    build: (p, ctx) => {
      const inputs = companyHistoryInputs(ctx.dataRoot, ctx.trackerPath ?? path.join(ctx.dataRoot, 'data', 'applications.md'));
      return node(ctx, 'companyHistory', ['--summary', ...opt(p.company, '--company'), ...inputs.args], inputs.env);
    },
  }),
  define({
    id: 'insights.keywordMatch',
    label: 'Keyword match',
    cost: 'free',
    resources: [],
    claude: false,
    sync: true,
    // keyword-match.mjs <report-file> --json: the report's file under reports/, read against cv.md. Two reports can share
    // a number, so a caller that knows which file the row links names it; with no file named, the number decides.
    params: z.object({ report: positive, file: z.string().min(1).max(255).optional() }),
    check: (p, ctx) => {
      if (p.file === undefined) return listReportFiles(ctx.dataRoot).has(p.report) ? null : `There is no file for report ${p.report} under reports/.`;
      return reportNumberOf(p.file) === p.report && listReportNames(ctx.dataRoot).includes(p.file) ? null : `There is no file ${p.file} for report ${p.report} under reports/.`;
    },
    build: (p, ctx) => node(ctx, 'keywordMatch', [path.join(ctx.dataRoot, 'reports', p.file ?? listReportFiles(ctx.dataRoot).get(p.report)!), '--json']),
    explainFailure: ({ code, stderr }) => ({ status: code === 1 ? 422 : 500, error: stderr.trim().split('\n').at(-1) || `keyword-match.mjs exited ${code}` }),
  }),
  // jd-skill-gap.mjs needs a JD file (it exits 1 with its usage text without one): the pasted JD goes to a temp file.
  define({ id: 'insights.jdSkillGap', label: 'JD skill gap', cost: 'free', resources: [], claude: false, sync: false, params: z.object({ text: z.string().min(1).max(50_000) }), build: (p, ctx) => node(ctx, 'jdSkillGap', [tmpFile(ctx, 'md', p.text), '--summary']) }),
  define({ id: 'insights.inviteMatch', label: 'Match invite text', cost: 'free', resources: [], claude: false, sync: true, params: z.object({ text: z.string().min(1).max(20_000) }), build: (p, ctx) => node(ctx, 'inviteMatch', ['--file', tmpFile(ctx, 'txt', p.text)]) }),
  define({ id: 'insights.linkedinJoin', label: 'LinkedIn join lookup', cost: 'network', resources: [], claude: false, sync: false, params: z.object({ company: company.optional() }), build: (p, ctx) => node(ctx, 'linkedinJoin', ['--summary', ...opt(p.company, '--company')]) }),
  // ---- follow-ups ----
  define({
    id: 'followups.seed',
    label: 'Seed follow-up cadence',
    cost: 'free',
    resources: ['followups'],
    claude: false,
    sync: false,
    // followup-seed.mjs <appNum> | --backfill (never both): one Applied row by number, or every Applied row.
    params: z
      .object({ appNum: positive.optional(), backfill: z.boolean().default(false), dryRun: z.boolean().default(false) })
      .refine((p) => p.backfill !== (p.appNum !== undefined), 'give an application number, or backfill every applied row, not both'),
    build: (p, ctx) => node(ctx, 'followupSeed', [...(p.backfill ? ['--backfill'] : [String(p.appNum)]), ...flag(p.dryRun, '--dry-run'), '--json']),
  }),
  define({
    id: 'followups.replyPaste',
    label: 'Paste a reply',
    cost: 'free',
    resources: ['tracker'],
    claude: false,
    sync: true,
    params: z.object({ subject: z.string().max(500), from: z.string().max(300), body: z.string().min(1).max(50_000) }),
    build: (p, ctx) => node(ctx, 'pasteReply', ['--file', tmpFile(ctx, 'eml', `From: ${p.from.replace(/[\r\n]+/g, ' ')}\nSubject: ${p.subject.replace(/[\r\n]+/g, ' ')}\n\n${p.body}\n`)]),
  }),
  define({
    id: 'followups.replyWatch',
    label: 'Reply watch digest',
    cost: 'free',
    resources: [],
    claude: false,
    sync: false,
    params: none,
    check: (_p, ctx) => replyWatchRefused(ctx.dataRoot),
    build: (_p, ctx) => node(ctx, 'replyWatch', []),
  }),
  define({ id: 'followups.inviteMatch', label: 'Match invite text', cost: 'free', resources: [], claude: false, sync: true, params: z.object({ text: z.string().min(1).max(20_000) }), build: (p, ctx) => node(ctx, 'inviteMatch', ['--file', tmpFile(ctx, 'txt', p.text)]) }),
  define({
    id: 'followups.contactsVcf',
    label: 'Export contacts (vCard)',
    cost: 'free',
    resources: [],
    claude: false,
    sync: true,
    // --caller-id is a switch (FN becomes "Jane Doe (Acme recruiter)"). The cards come back as the result, never a file.
    params: z.object({ callerId: z.boolean().default(false) }),
    build: (p, ctx) => ({ bin: process.execPath, args: [path.join(ctx.codeRoot, CONTACTS_VCF), ...flag(p.callerId, '--caller-id')], cwd: ctx.codeRoot }),
    explainFailure: ({ code, stderr }) => {
      const last = stderr.trim().split('\n').at(-1) ?? '';
      return code === 3 ? { status: 404, error: last } : { status: 500, error: `The vCard export failed (exit ${code}): ${last || 'no output'}` };
    },
  }),
  define({ id: 'followups.linkedinJoin', label: 'LinkedIn join lookup', cost: 'network', resources: [], claude: false, sync: false, params: z.object({ company: company.optional() }), build: (p, ctx) => node(ctx, 'linkedinJoin', ['--summary', ...opt(p.company, '--company')]) }),
  // ---- plugins ----
  define({ id: 'plugins.list', label: 'List plugins', cost: 'free', resources: [], claude: false, sync: true, params: none, build: (_p, ctx) => node(ctx, 'plugins', ['list']) }),
  define({
    id: 'plugins.run',
    label: 'Run plugin hook',
    cost: 'network',
    resources: [],
    claude: false,
    sync: false,
    // A hook finds-else-creates on the plugin's service (a Notion export creates a page per row it does not find), so
    // two runs at once would both create the same pages. single is per action, so a run of one plugin also waits out
    // another plugin's run.
    single: (mine) => `Skipped: a plugin hook is already ${mine.status === 'queued' ? 'queued' : 'running'} from here (run ${mine.id}). Watch it on Runs & Schedule and run again once it ends.`,
    params: z.object({ id: safeToken, hook: safeToken.optional(), args: z.array(safeToken).max(10).default([]) }),
    build: (p, ctx) => node(ctx, 'plugins', ['run', p.id, ...(p.hook ? [p.hook] : []), ...p.args]),
  }),
  define({ id: 'plugins.audit', label: 'Audit plugins', cost: 'free', resources: [], claude: false, sync: false, params: none, build: (_p, ctx) => ({ bin: process.execPath, args: [path.join(ctx.codeRoot, PLUGIN_AUDIT_ALL), ctx.pluginsLocalDir ?? path.join(ctx.codeRoot, 'plugins.local')], cwd: ctx.codeRoot }) }),
  // ---- system ----
  define({ id: 'system.doctor', label: 'Doctor', cost: 'free', resources: [], claude: false, sync: true, params: none, build: (_p, ctx) => node(ctx, 'doctor', ['--json']) }),
  define({ id: 'system.updateStatus', label: 'Update status', cost: 'free', resources: [], claude: false, sync: true, params: none, build: (_p, ctx) => node(ctx, 'updateSystem', ['status']) }),
  define({ id: 'system.updateCheck', label: 'Check for updates', cost: 'network', resources: [], claude: false, sync: false, params: z.object({ force: z.boolean().default(false) }), build: (p, ctx) => node(ctx, 'updateSystem', ['check', ...flag(p.force, '--force')]) }),
  define({ id: 'system.updateApply', label: 'Apply update', cost: 'network', confirm: 'This fork takes updates through the weekly sync PR. Applying directly can conflict with it. Continue anyway?', resources: ['tracker', 'pipeline', 'portals', 'profile'], claude: false, sync: false, params: none, build: (_p, ctx) => node(ctx, 'updateSystem', ['apply', '--confirm']) }),
  define({ id: 'system.updateDismiss', label: 'Dismiss update', cost: 'free', resources: [], claude: false, sync: true, params: z.object({ version: z.string().regex(/^v?\d+\.\d+\.\d+$/i, 'a release version, X.Y.Z, as update-system.mjs dismiss takes') }), build: (p, ctx) => node(ctx, 'updateSystem', ['dismiss', '--version', p.version]) }),
  define({ id: 'system.rollback', label: 'Roll back update', cost: 'free', confirm: 'Rolls back the last applied update. Continue?', resources: ['tracker', 'pipeline', 'portals', 'profile'], claude: false, sync: false, params: none, build: (_p, ctx) => node(ctx, 'updateSystem', ['rollback']) }),
  // ---- daily job, dev chat ----
  define({
    id: 'daily.runNow',
    label: 'Run the daily job now',
    cost: 'tokens',
    confirm: 'Runs the full daily job (policy watch with Claude, portal scan, prioritize, rank, shortlist). Continue?',
    resources: ['pipeline', 'tracker', 'immigration:policy'],
    claude: true,
    sync: false,
    params: none,
    // A second run would only find the job's lock held and skip: say so now instead of starting a run that does nothing.
    // A run this app started may still be queued behind a scan, or starting, before run-daily.sh holds its lock: a
    // second one would run the whole job again once the first ends.
    single: (mine) => `Skipped: the daily job is already ${mine.status === 'queued' ? 'queued' : 'running'} from here (run ${mine.id}). Watch it on Runs & Schedule.`,
    check: async (_p, ctx) => {
      if (await ctx.dailyRunning?.()) return { status: 409, error: 'Skipped: the daily job is already running (its schedule or another start began it). Watch it on Runs & Schedule; it ran nothing new.' };
      // The job runs the AI policy pass: with a manual pass running, both would take the same queued items.
      const pass = ctx.policyPassRunning?.();
      // The daily job's own claim (its pidfile) is the running-job case above; any other live holder is a session.
      return pass && !pass.owner.startsWith('daily:') ? { status: 409, error: `Skipped: an AI policy pass is running or waiting for a reply (${pass.owner}), and the daily job would run the same pass. Try again once it finishes.` } : null;
    },
    // CC_RUN_DAILY_SKIP_EXIT: should the job start in between, run-daily.sh still finds the lock held, and then says
    // it skipped and exits 75, so this run ends failed with that line instead of done with an empty log.
    build: (_p, ctx) => ({ bin: '/bin/bash', args: [path.join(ctx.codeRoot, RUN_DAILY)], cwd: ctx.codeRoot, env: { CC_RUN_DAILY_SKIP_EXIT: '75', ...(ctx.claudeBin && path.isAbsolute(ctx.claudeBin) ? { CC_CLAUDE_BIN: ctx.claudeBin } : {}), ...(ctx.nodeBin && path.isAbsolute(ctx.nodeBin) ? { CC_NODE_BIN: ctx.nodeBin } : {}) } }),
  }),
  define({ id: 'devchat.installDeps', label: 'Install Control Center dependencies', cost: 'network', confirm: 'Runs npm install for custom/control-center. Continue?', resources: [], claude: false, sync: false, params: none, single: (mine) => `Skipped: an install is already ${mine.status === 'queued' ? 'queued' : 'running'} from here (run ${mine.id}). Watch it on Runs & Schedule.`, build: (_p, ctx) => ({ bin: 'npm', args: ['--prefix', path.join(ctx.codeRoot, 'custom', 'control-center'), 'install'], cwd: ctx.codeRoot }) }),
];

export function findAction(id: string): ActionDef | undefined {
  return ACTIONS.find((a) => a.id === id);
}

export function actionMetadata() {
  return ACTIONS.map((a) => ({
    id: a.id,
    label: a.label,
    cost: a.cost,
    confirm: a.confirm ?? null,
    resources: a.resources,
    claude: a.claude,
    sync: a.sync,
    // The input schema: a field with a default is optional to the caller, as it is to the zod parse.
    params: z.toJSONSchema(a.params, { io: 'input' }),
  }));
}
