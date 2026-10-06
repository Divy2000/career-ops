// Spec section 1 inventory: every capability id names where it landed (an API
// route, a registry action, a session mode, a web component or an e2e step) and
// this test proves that location exists and is exercised.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIONS, actionMetadata } from '../../server/actions/registry.js';
import modes from '../../server/claude/modes.generated.json' with { type: 'json' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readTree(dir: string, ext: RegExp): string {
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out += readTree(abs, ext);
    else if (ext.test(e.name)) out += fs.readFileSync(abs, 'utf8') + '\n';
  }
  return out;
}

const serverSrc = readTree(path.join(ROOT, 'server'), /\.ts$/);
const webSrc = readTree(path.join(ROOT, 'web'), /\.tsx?$/);
const e2eSrc = readTree(path.join(ROOT, 'tests', 'e2e'), /\.spec\.ts$/);
const apiTestSrc = readTree(path.join(ROOT, 'tests', 'api'), /\.test\.ts$/);
const routerSrc = fs.readFileSync(path.join(ROOT, 'web', 'router.tsx'), 'utf8');
const modeIds = new Set((modes as Array<{ id: string }>).map((m) => m.id));

type Reach = { api?: string; action?: string; mode?: string; web?: string; e2e?: string; route?: string };

const INVENTORY: Array<[id: string, reach: Reach]> = [
  // 1a web alpha
  ['alpha.today.followups-due', { api: '/api/followups' }],
  ['alpha.today.decisions', { e2e: 'Decisions' }],
  ['alpha.today.fresh-matches', { api: '/api/whats-new' }],
  ['alpha.quick-evaluate-url', { web: 'QuickEvaluate' }],
  ['alpha.cv-import', { api: '/api/cv/upload' }],
  ['alpha.onboarding-doctor', { action: 'system.doctor' }],
  ['alpha.network-scan', { action: 'scan.network' }],
  ['alpha.ai-search', { web: 'AiSearchTab' }],
  ['alpha.pipeline-add', { api: '/api/pipeline/add' }],
  ['alpha.inbox-skip-undo', { api: '/api/pipeline/skip' }],
  ['alpha.inbox-evaluate-selected', { web: 'fanOut' }],
  ['alpha.tracker-table', { e2e: 'Search tracker' }],
  ['alpha.report-view', { e2e: 'A) Role Summary' }],
  ['alpha.documents-pdf', { api: '/api/tracker/:n/documents' }],
  ['alpha.tracker-delete', { action: 'tracker.delete' }],
  ['alpha.apply-form-proxy', { route: '/apply/$n' }],
  ['alpha.followup-log', { api: '/api/followups/log' }],
  ['alpha.followup-override', { api: '/api/followups/override' }],
  ['alpha.cadence-settings', { api: '/api/followups/cadence' }],
  ['alpha.portal-health', { action: 'portals.verify' }],
  ['alpha.analytics', { api: '/api/insights/dashboard' }],
  ['alpha.cv-editor', { api: '/api/files/user/:key' }],
  ['alpha.config-engine', { api: '/api/system/status' }],
  ['alpha.config-logos', { web: 'Company logos' }],
  ['alpha.assistant-console', { web: 'AskDrawer' }],
  ['alpha.worker-pills-activity', { web: 'ActivityChip' }],
  ['alpha.research-worker', { mode: 'research' }],
  ['alpha.usage-meter', { api: '/api/usage' }],
  // 1b TUI
  ['tui.filter-tabs', { e2e: 'tab=interview' }],
  ['tui.sort-modes', { e2e: 'aria-sort' }],
  ['tui.grouped-flat', { e2e: 'Flat list' }],
  ['tui.search-notes', { web: 'r.notes' }],
  ['tui.column-picker', { web: 'cc.tracker.cols' }],
  ['tui.preview-pane', { e2e: 'Preview' }],
  ['tui.report-status-change', { action: 'tracker.setStatus' }],
  ['tui.open-posting', { web: 'Open posting' }],
  ['tui.pdf-picker', { api: '/api/tracker/:n/documents' }],
  ['tui.rerender-pdf', { action: 'docs.renderPdf' }],
  ['tui.status-picker', { web: 'StatusControl' }],
  ['tui.discard-reason', { e2e: 'Discard reason' }],
  ['tui.hired-flow', { action: 'tracker.hiredShare' }],
  ['tui.progress', { e2e: 'Progress' }],
  ['tui.stats', { e2e: 'Archetypes' }],
  ['tui.keyboard', { web: "case 'j'" }],
  // 1c modes (every mode but batch, which is refused as a session, is also launchable from the palette and Sessions > New)
  ...['auto-pipeline', 'oferta', 'ofertas', 'pipeline', 'triage', 'batch', 'pdf', 'pdf/hm-audit', 'text', 'latex', 'latex-tex', 'titles', 'cover', 'email', 'contacto', 'deep', 'interview-prep', 'interview/plan', 'interview/practice', 'interview/debrief', 'interview-redflag', 'offer-prep', 'outcome', 'apply', 'followup', 'reply-watch', 'patterns', 'calibrate', 'upskill', 'training', 'project', 'interview', 'master-profile', 'add', 'expand', 'intake', 'scan', 'discover', 'tracker', 'agent-inbox', 'update'].map((m): [string, Reach] => [`mode.${m}`, { mode: m }]),
  ['mode.compare-ofertas-host', { e2e: 'Compare selected' }],
  ['mode.ai-analyses-host', { web: "id: 'calibrate'" }],
  // 1d core scripts (application-artifacts.mjs runs inside the pdf mode, not as an action: R8-11)
  ...['system.doctor', 'tracker.verify', 'tracker.normalize', 'tracker.dedup', 'tracker.merge', 'tracker.reconcile', 'tracker.syncCheck', 'scan.portals', 'scan.full', 'scan.seeds', 'scan.hn', 'scan.interamt', 'scan.funded', 'scan.reposts', 'portals.validate', 'portals.verify', 'portals.audit', 'portals.fixSlugs', 'pipeline.rank', 'pipeline.prioritize', 'pipeline.shortlist', 'pipeline.reserveReportNums', 'insights.stats', 'insights.funnelVelocity', 'insights.analyzePatterns', 'insights.salaryGap', 'insights.upskill', 'insights.companyHistory', 'insights.rejectionLatency', 'insights.processQuality', 'insights.weeklyDigest', 'insights.assessmentLog', 'insights.keywordMatch', 'insights.jdSkillGap', 'insights.storyProvenance', 'insights.inviteMatch', 'insights.linkedinJoin', 'followups.contactsVcf', 'followups.seed', 'docs.renderPdf', 'docs.coverPdf', 'docs.imgToPdf', 'docs.archivePosting', 'docs.liveness', 'docs.fetchJd', 'docs.prepareApplication', 'followups.replyPaste', 'followups.replyWatch', 'plugins.list', 'plugins.run', 'plugins.audit', 'system.updateStatus', 'system.updateCheck', 'system.updateApply', 'system.updateDismiss', 'system.rollback', 'daily.runNow', 'devchat.installDeps'].map((a): [string, Reach] => [`script.${a}`, { action: a }]),
  // Pipeline > Batch: one confined session per URL through the fan-out, not batch-runner.sh.
  ['script.pipeline.batchRun', { api: '/api/sessions/fanout', web: '<BatchTab' }],
  ['script.plugins.enable', { api: '/api/config/plugins/:id' }],
  ['script.plugins.skill', { api: '/api/plugins/:id/skill' }],
  ['script.insights.cached', { api: '/api/insights/:script' }],
  // 1e add-ons
  ['addon.immigration-watch', { action: 'immigration.watch' }],
  ['addon.daily-ai-policy-pass', { web: 'immigration-policy' }],
  ['addon.freshness', { action: 'immigration.freshness' }],
  ['addon.sponsorship-check', { web: 'sponsorship-check' }],
  ['addon.daily-job-schedule', { api: '/api/schedule/:label' }],
  ['addon.daily-job-logs', { api: '/api/schedule/logs/:date' }],
  ['addon.shortlist', { api: '/api/shortlist' }],
  ['addon.h1b-lookup', { action: 'immigration.h1b' }],
  ['addon.h1b-lookup-tab', { api: '/api/sponsorship/lookup' }],
  ['addon.h1b-name-search', { api: '/api/sponsorship/search' }],
  ['addon.sponsorship-overview', { api: '/api/immigration/overview' }],
  ['addon.today-workflow', { route: '/' }],
  ['tutorials.list', { api: '/api/tutorials' }],
  ['tutorials.media', { api: '/api/tutorials/:id/media/:file' }],
  ['tutorials.page', { route: '/tutorials' }],
  ['tutorials.player', { web: 'TutorialsPage' }],
  // P3 editors
  ['settings.portals-structured', { api: '/api/config/:key' }],
  ['settings.blacklist-explicit', { api: '/api/blacklist' }],
  ['settings.app', { api: '/api/settings/app' }],
  ['settings.contacts', { api: '/api/contacts' }],
  ['settings.interviews', { api: '/api/interviews' }],
  // Fork: projects library (article-digest.md) in Profile > Projects
  ['projects.list', { api: '/api/projects' }],
  ['projects.edit-delete', { api: '/api/projects/:id' }],
  ['projects.validate', { api: '/api/projects/validate' }],
  ['projects.convert', { api: '/api/projects/convert' }],
  ['projects.append', { api: '/api/projects/append' }],
  ['projects.upload-source', { api: '/api/projects/upload' }],
  ['projects.rank', { action: 'projects.rank' }],
  ['projects.ingest-session', { web: 'projects-ingest' }],
  ['projects.tab', { web: 'ProjectsLibrary', e2e: 'Profile > Projects library' }],
];

/**
 * Parameters the palette's params dialog (web/components/CommandPalette.tsx) cannot ask for: it renders a checkbox, a
 * select for an enum or a union of consts, a number field, a one-per-line list of scalars, or a text field.
 */
type ParamProp = { type?: string | string[]; enum?: unknown[]; anyOf?: Array<{ const?: unknown }>; items?: { type?: string } };
function unaskable(params: unknown): string[] {
  const props = ((params as { properties?: Record<string, ParamProp> }).properties ?? {}) as Record<string, ParamProp>;
  const typeOf = (p: ParamProp) => (Array.isArray(p.type) ? (p.type.find((t) => t !== 'null') ?? 'string') : (p.type ?? 'string'));
  const choices = (p: ParamProp) => Boolean(p.enum) || Boolean(p.anyOf?.length && p.anyOf.every((o) => 'const' in o));
  const scalar = (t: string | undefined) => t === 'string' || t === 'number' || t === 'integer';
  return Object.entries(props)
    .filter(([, p]) => !(choices(p) || ['string', 'number', 'integer', 'boolean'].includes(typeOf(p)) || (typeOf(p) === 'array' && scalar(p.items?.type))))
    .map(([k]) => k);
}

describe('the palette params check', () => {
  it('names a parameter the dialog cannot ask for (an object, a list of objects) and passes the field kinds it renders', () => {
    expect(unaskable({ properties: { filters: { type: 'object' }, rows: { type: 'array', items: { type: 'object' } }, dryRun: { type: 'boolean' }, ats: { type: 'array', items: { type: 'string' } }, sinceDays: { anyOf: [{ const: 7 }, { const: 30 }] }, row: { type: 'integer' } } })).toEqual(['filters', 'rows']);
  });
});

describe('spec section 1 inventory reaches its new location', () => {
  it('lists every capability exactly once', () => {
    const ids = INVENTORY.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(140);
  });

  it.each(INVENTORY)('%s', (_id, reach) => {
    if (reach.api) {
      expect(serverSrc, `route ${reach.api} is registered`).toContain(`'${reach.api}'`);
      // The whole route, each :param standing for any one path segment (a literal or a template expression).
      const route = new RegExp(reach.api.split('/').map((seg) => (seg.startsWith(':') ? "[^/'\"`\\s?]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + "(?![\\w-])");
      expect(apiTestSrc + e2eSrc, `route ${reach.api} is exercised by an API or e2e test`).toMatch(route);
    }
    if (reach.action) {
      expect(ACTIONS.map((a) => a.id), `action ${reach.action} is registered`).toContain(reach.action);
      // An action no page hosts is launched from the palette, which lists every registered action; it can only launch one
      // whose every parameter its params dialog can ask for (SW2-tests-26: "listed" alone was always true).
      const hosted = webSrc.includes(`'${reach.action}'`);
      const meta = actionMetadata().find((a) => a.id === reach.action)!;
      expect(hosted || unaskable(meta.params).length === 0, `action ${reach.action} is launched from a page, or the palette can ask for ${unaskable(meta.params).join(', ')}`).toBe(true);
    }
    if (reach.mode) expect(modeIds.has(reach.mode) || webSrc.includes(`'${reach.mode}'`), `mode ${reach.mode} is registered`).toBe(true);
    if (reach.web) expect(webSrc, `web source mentions ${reach.web}`).toContain(reach.web);
    if (reach.e2e) expect(e2eSrc, `an e2e step mentions ${reach.e2e}`).toContain(reach.e2e);
    if (reach.route) expect(routerSrc, `router defines ${reach.route}`).toContain(`path: '${reach.route}'`);
  });
});
