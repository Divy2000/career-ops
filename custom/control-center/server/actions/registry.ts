// Static action registry: the only way the client runs anything. Every entry
// builds an argv array; the client never sends a command string.
import path from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import type { Cost } from '../runner/store.js';
import { cliScriptPath } from '../core/adapter.js';
import { readPdfIndex, rerenderProblem, resolveOutputFile } from '../domains/documents.js';
import { readTracker } from '../domains/tracker.js';
import { prefillUrlProblem } from '../../shared/prefill.js';
import { writeTmpInput } from './tmp-inputs.js';

export type Resource = 'tracker' | 'pipeline' | 'portals' | 'profile' | 'followups' | 'cv' | 'blacklist' | 'launchd' | `immigration:${string}`;

export interface ActionContext {
  codeRoot: string;
  dataRoot: string;
}

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
  /** Confirmation text shown before running; undefined means no confirm. */
  confirm?: string;
  resources: Resource[];
  claude: boolean;
  /** Sync actions run inline under a 30 s timeout and return their output. */
  sync: boolean;
  params: S;
  /** A readable reason these params cannot run against the data root (missing input files and the like); checked before build. */
  check?: (params: z.infer<S>, ctx: ActionContext) => string | null | Promise<string | null>;
  build: (params: z.infer<S>, ctx: ActionContext) => Command;
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
const none = z.object({});
const dryRun = z.object({ dryRun: z.boolean().default(false) });
const positive = z.number().int().positive();
const safeToken = z.string().min(1).max(200).regex(/^[\w.@:,/+=-]+$/, 'letters, digits and . _ - : , / + = @ only');
const relOutput = z.string().regex(/^output\/[\w.-]+$/, 'a file directly under output/');
const outputPath = (ext: RegExp, what: string) =>
  z
    .string()
    .max(512)
    .regex(/^output\/(?:[\w.-]+\/)*[\w.-]+$/, 'a file under output/')
    .refine((p) => !p.split('/').includes('..'), 'no .. segments')
    .refine((p) => ext.test(p), what);
const httpUrl = z.string().url().refine((u) => /^https?:\/\//.test(u), 'http(s) only').max(2048);
const company = z.string().min(1).max(200).regex(/^[^\0\r\n]+$/);

/** Ephemeral input files live under the data root, never in the repo, and go when the run ends (tmp-inputs.ts). */
const tmpFile = (ctx: ActionContext, ext: string, content: string): string => writeTmpInput(ctx.dataRoot, ext, content);

const RUN_DAILY = 'custom/immigration/run-daily.sh';

export const ACTIONS: ActionDef[] = [
  // ---- tracker ----
  define({
    id: 'tracker.setStatus',
    label: 'Set application status',
    cost: 'free',
    resources: ['tracker'],
    claude: false,
    sync: true,
    params: z.object({ row: positive, state: z.enum(TRACKER_STATES), note: z.string().max(500).optional(), on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    build: (p, ctx) => node(ctx, 'setStatus', ['--row', String(p.row), p.state, '--source', 'web', '--json', ...opt(p.note, '--note'), ...opt(p.on, '--on')]),
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
    params: z.object({ n: positive, dryRun: z.boolean().default(false) }),
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
    params: z.object({ dryRun: z.boolean().default(false), verify: z.boolean().default(false), backfillUrls: z.boolean().default(false) }),
    build: (p, ctx) => node(ctx, 'mergeTracker', [...flag(p.dryRun, '--dry-run'), ...flag(p.verify, '--verify'), ...flag(p.backfillUrls, '--backfill-urls')]),
  }),
  define({ id: 'tracker.reconcile', label: 'Reconcile pipeline with tracker', cost: 'free', resources: ['tracker', 'pipeline'], claude: false, sync: false, params: dryRun, build: (p, ctx) => node(ctx, 'reconcilePipeline', flag(p.dryRun, '--dry-run')) }),
  define({ id: 'tracker.syncCheck', label: 'Tracker sync check', cost: 'free', resources: [], claude: false, sync: true, params: none, build: (_p, ctx) => node(ctx, 'tracker', ['sync', '--check']) }),
  define({
    id: 'tracker.hiredShare',
    label: 'Draft Hired Wall story',
    cost: 'free',
    resources: [],
    claude: false,
    sync: true,
    params: z.object({ report: positive, anonymity: z.enum(['handle', 'role', 'count']), story: z.string().max(2000).optional() }),
    build: (p, ctx) => node(ctx, 'hiredShare', ['--report', String(p.report), '--anonymity', p.anonymity, ...opt(p.story, '--story')]),
  }),
  define({
    id: 'tracker.hiredMark',
    label: 'Record the Hired Wall answer',
    cost: 'free',
    resources: [],
    claude: false,
    sync: true,
    params: z.object({ report: positive, mark: z.enum(['shared', 'later', 'never']) }),
    build: (p, ctx) => node(ctx, 'hiredShare', ['--report', String(p.report), '--mark', p.mark]),
  }),
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
  define({ id: 'pipeline.releaseReportNums', label: 'Release report numbers', cost: 'free', resources: ['tracker'], claude: false, sync: true, params: z.object({ range: z.string().regex(/^\d+(-\d+)?(,\d+(-\d+)?)*$/) }), build: (p, ctx) => node(ctx, 'reserveReportNum', ['--release', p.range]) }),
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
      ats: z.array(safeToken).min(1).max(10),
      limit: positive.min(50).max(500).default(100),
      seeds: safeToken.optional(),
      includeUndated: z.boolean().default(false),
    }),
    build: (p, ctx) => {
      const portals = YAML.stringify({
        title_filter: { include: p.roles, exclude: p.exclude },
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
    params: z.object({ months: positive.max(36).default(6), sort: z.enum(['date', 'amount', 'name']).optional(), sources: safeToken.optional() }),
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
    build: (p, ctx) => node(ctx, 'auditPortals', ['--json', ...opt(p.company, '--company'), ...opt(p.smallThreshold, '--small-threshold'), ...(p.baselineRunId ? ['--baseline', path.join(ctx.dataRoot, 'data', 'control-center', 'runs', p.baselineRunId, 'raw.ndjson')] : [])]),
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
    build: (p, ctx) => node(ctx, 'fixSlugs', p.apply ? ['--apply'] : ['--dry-run']),
  }),
  // ---- immigration ----
  define({ id: 'immigration.watch', label: 'Check official feeds', cost: 'network', resources: ['immigration:policy'], claude: false, sync: false, params: z.object({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), build: (p, ctx) => node(ctx, 'immigrationWatch', opt(p.since, '--since')) }),
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
    resources: [],
    claude: false,
    sync: false,
    // generate-pdf.mjs files the PDF in pdf-index.tsv under --report, so it must be the row's report, never the row number.
    params: z.object({ row: positive, report: positive, html: outputPath(/\.html$/i, 'an .html file'), pdf: outputPath(/\.pdf$/i, 'a .pdf file'), format: z.enum(['letter', 'a4']).default('letter') }),
    check: async (p, ctx) => {
      const tracker = await readTracker(ctx.codeRoot, ctx.dataRoot);
      const row = tracker.kind === 'ok' ? tracker.rows.find((r) => r.num === p.row) : undefined;
      if (!row) return `There is no tracker row #${p.row}.`;
      if (row.report === null) return `Row #${p.row} has no evaluation report, so a re-rendered PDF has nowhere to be filed.`;
      if (row.report !== p.report) return `Row #${p.row} is filed under report ${row.report}, not report ${p.report}. Reload the Documents tab and try again.`;
      return rerenderProblem(readPdfIndex(ctx.dataRoot), p.report, p.html, p.pdf);
    },
    build: (p, ctx) => node(ctx, 'generatePdf', [path.join(ctx.dataRoot, p.html), path.join(ctx.dataRoot, p.pdf), `--format=${p.format}`, `--report=${p.report}`]),
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
  define({ id: 'docs.coverPdf', label: 'Render cover letter PDF', cost: 'free', resources: [], claude: false, sync: false, params: z.object({ payloadPath: relOutput }), build: (p, ctx) => node(ctx, 'generateCoverLetter', ['--payload', path.join(ctx.dataRoot, p.payloadPath)]) }),
  define({ id: 'docs.archivePosting', label: 'Archive posting', cost: 'network', resources: [], claude: false, sync: false, params: z.object({ n: positive, url: httpUrl }), build: (p, ctx) => node(ctx, 'archivePosting', [p.url, '--report', String(p.n)]) }),
  define({ id: 'docs.liveness', label: 'Check posting liveness', cost: 'network', resources: [], claude: false, sync: false, params: z.object({ urls: z.array(httpUrl).min(1).max(200) }), build: (p, ctx) => node(ctx, 'checkLiveness', ['--file', tmpFile(ctx, 'txt', p.urls.join('\n') + '\n')]) }),
  define({ id: 'docs.fetchJd', label: 'Fetch job description', cost: 'network', resources: [], claude: false, sync: false, params: z.object({ url: httpUrl }), build: (p, ctx) => node(ctx, 'fetchJd', [p.url]) }),
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
  define({ id: 'docs.appArtifactsInit', label: 'Initialize application artifacts', cost: 'free', resources: [], claude: false, sync: true, params: z.object({ n: positive }), build: (p, ctx) => node(ctx, 'applicationArtifacts', ['--init', '--report', String(p.n)]) }),
  define({ id: 'docs.imgToPdf', label: 'Image to PDF', cost: 'free', resources: [], claude: false, sync: false, params: z.object({ file: relOutput }), build: (p, ctx) => node(ctx, 'imgToPdf', [path.join(ctx.dataRoot, p.file)]) }),
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
      ['insights.jdSkillGap', 'JD skill gap', 'jdSkillGap'],
      ['insights.storyProvenance', 'Story provenance check', 'storyProvenanceCheck'],
      ['insights.contacts', 'Contacts summary', 'contacts'],
    ] as Array<[string, string, CliId]>
  ).map(([id, label, cli]) => define({ id, label, cost: 'free', resources: [], claude: false, sync: false, params: none, build: (_p, ctx) => node(ctx, cli, ['--summary']) })),
  define({ id: 'insights.companyHistory', label: 'Company history', cost: 'free', resources: [], claude: false, sync: false, params: z.object({ company: company.optional() }), build: (p, ctx) => node(ctx, 'companyHistory', ['--summary', ...opt(p.company, '--company')]) }),
  define({ id: 'insights.keywordMatch', label: 'Keyword match', cost: 'free', resources: [], claude: false, sync: true, params: z.object({ n: positive.optional() }), build: (p, ctx) => node(ctx, 'keywordMatch', ['--json', ...(p.n ? [String(p.n)] : [])]) }),
  define({ id: 'insights.inviteMatch', label: 'Match invite text', cost: 'free', resources: [], claude: false, sync: true, params: z.object({ text: z.string().min(1).max(20_000) }), build: (p, ctx) => node(ctx, 'inviteMatch', ['--file', tmpFile(ctx, 'txt', p.text)]) }),
  define({ id: 'insights.linkedinJoin', label: 'LinkedIn join lookup', cost: 'network', resources: [], claude: false, sync: false, params: z.object({ company: company.optional() }), build: (p, ctx) => node(ctx, 'linkedinJoin', ['--summary', ...opt(p.company, '--company')]) }),
  // ---- follow-ups ----
  define({ id: 'followups.seed', label: 'Seed follow-up cadence', cost: 'free', resources: ['followups'], claude: false, sync: false, params: z.object({ backfill: z.boolean().default(false) }), build: (p, ctx) => node(ctx, 'followupSeed', [...flag(p.backfill, '--backfill'), '--json']) }),
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
  define({ id: 'followups.replyWatch', label: 'Reply watch digest', cost: 'free', resources: [], claude: false, sync: false, params: none, build: (_p, ctx) => node(ctx, 'replyWatch', []) }),
  define({ id: 'followups.inviteMatch', label: 'Match invite text', cost: 'free', resources: [], claude: false, sync: true, params: z.object({ text: z.string().min(1).max(20_000) }), build: (p, ctx) => node(ctx, 'inviteMatch', ['--file', tmpFile(ctx, 'txt', p.text)]) }),
  define({ id: 'followups.contactsVcf', label: 'Export contacts (vCard)', cost: 'free', resources: [], claude: false, sync: true, params: z.object({ callerId: safeToken }), build: (p, ctx) => node(ctx, 'contacts', ['--vcf', '--caller-id', p.callerId]) }),
  define({ id: 'followups.linkedinJoin', label: 'LinkedIn join lookup', cost: 'network', resources: [], claude: false, sync: false, params: z.object({ company: company.optional() }), build: (p, ctx) => node(ctx, 'linkedinJoin', ['--summary', ...opt(p.company, '--company')]) }),
  // ---- plugins ----
  define({ id: 'plugins.list', label: 'List plugins', cost: 'free', resources: [], claude: false, sync: true, params: none, build: (_p, ctx) => node(ctx, 'plugins', ['list']) }),
  define({ id: 'plugins.run', label: 'Run plugin hook', cost: 'network', resources: [], claude: false, sync: false, params: z.object({ id: safeToken, hook: safeToken.optional(), args: z.array(safeToken).max(10).default([]) }), build: (p, ctx) => node(ctx, 'plugins', ['run', p.id, ...(p.hook ? [p.hook] : []), ...p.args]) }),
  define({ id: 'plugins.audit', label: 'Audit plugins', cost: 'free', resources: [], claude: false, sync: false, params: none, build: (_p, ctx) => node(ctx, 'pluginAudit', []) }),
  // ---- system ----
  define({ id: 'system.doctor', label: 'Doctor', cost: 'free', resources: [], claude: false, sync: true, params: none, build: (_p, ctx) => node(ctx, 'doctor', ['--json']) }),
  define({ id: 'system.updateStatus', label: 'Update status', cost: 'free', resources: [], claude: false, sync: true, params: none, build: (_p, ctx) => node(ctx, 'updateSystem', ['status']) }),
  define({ id: 'system.updateCheck', label: 'Check for updates', cost: 'network', resources: [], claude: false, sync: false, params: z.object({ force: z.boolean().default(false) }), build: (p, ctx) => node(ctx, 'updateSystem', ['check', ...flag(p.force, '--force')]) }),
  define({ id: 'system.updateApply', label: 'Apply update', cost: 'network', confirm: 'This fork takes updates through the weekly sync PR. Applying directly can conflict with it. Continue anyway?', resources: ['tracker', 'pipeline', 'portals', 'profile'], claude: false, sync: false, params: none, build: (_p, ctx) => node(ctx, 'updateSystem', ['apply', '--confirm']) }),
  define({ id: 'system.updateDismiss', label: 'Dismiss update', cost: 'free', resources: [], claude: false, sync: true, params: z.object({ version: z.string().regex(/^[\w.+-]+$/) }), build: (p, ctx) => node(ctx, 'updateSystem', ['dismiss', '--version', p.version]) }),
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
    build: (_p, ctx) => ({ bin: '/bin/bash', args: [path.join(ctx.codeRoot, RUN_DAILY)], cwd: ctx.codeRoot }),
  }),
  define({ id: 'devchat.installDeps', label: 'Install Control Center dependencies', cost: 'network', confirm: 'Runs npm install for custom/control-center. Continue?', resources: [], claude: false, sync: false, params: none, build: (_p, ctx) => ({ bin: 'npm', args: ['--prefix', path.join(ctx.codeRoot, 'custom', 'control-center'), 'install'], cwd: ctx.codeRoot }) }),
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
    params: z.toJSONSchema(a.params),
  }));
}
