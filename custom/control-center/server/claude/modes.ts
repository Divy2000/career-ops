// Mode registry and policy classes (spec section 4.2). The derived snapshot in
// modes.generated.json is produced by scripts/derive-mode-policies.ts and
// frozen; tests/unit/modes.test.ts fails when the modes/ tree drifts from it.
import generated from './modes.generated.json' with { type: 'json' };
import { AGENT_SPAWNING_SCRIPTS } from './guard-policy.mjs';
import { ALWAYS_DENIED_WRITES, CODE_ROOT_WRITE_GLOBS } from './confinement.mjs';

export interface DerivedMode {
  id: string;
  file: string;
  title: string;
  scripts: string[];
  paths: string[];
}

export const MODES: readonly DerivedMode[] = generated as DerivedMode[];

export type PolicyClass =
  | 'evaluate'
  | 'documents'
  | 'outreach'
  | 'interview'
  | 'offer'
  | 'profile'
  | 'analysis'
  | 'scan'
  | 'apply'
  | 'fix-portal'
  | 'immigration-policy'
  | 'sponsorship-check'
  | 'read-only'
  | 'update'
  | 'devchat';

export type NetworkTool = 'WebFetch' | 'WebSearch';

export interface PolicyClassDef {
  writeGlobs: string[];
  network: NetworkTool[];
  /** Scripts (relative to the code root) the class may run with Bash. */
  extraBash: string[];
  /** Exact-prefix Bash allowlist that replaces the script-derived one (Dev Chat). */
  bashPrefixes?: string[][];
  allowsTask?: boolean;
  mcp?: 'playwright';
}

export const POLICY_CLASSES: Record<PolicyClass, PolicyClassDef> = {
  evaluate: {
    writeGlobs: [
      'reports/**',
      'batch/tracker-additions/**',
      'jds/**',
      'output/**',
      'data/immigration/companies/**',
      'data/immigration/company-alerts.tsv',
      'interview-prep/story-bank.md',
    ],
    network: ['WebFetch', 'WebSearch'],
    extraBash: [
      'reserve-report-num.mjs',
      'merge-tracker.mjs',
      'set-status.mjs',
      'check-liveness.mjs',
      'fetch-jd.mjs',
      'archive-posting.mjs',
      'generate-pdf.mjs',
      'jd-skill-gap.mjs',
      'custom/immigration/freshness.mjs',
      'plugins/h1b-sponsor/check.mjs',
      'custom/projects/rank.mjs',
      'custom/cv/build-html.mjs',
      'custom/cv/render-pdf.mjs',
    ],
  },
  documents: {
    // jds/<slug>.md: modes/pdf.md saves the JD there before anything else, and the projects house rule ranks it from there.
    writeGlobs: ['output/**', 'jds/*.md', 'templates/cv-*.html', 'templates/cover-*.html', '*.tex'],
    network: ['WebSearch'],
    extraBash: ['generate-pdf.mjs', 'generate-cover-letter.mjs', 'build-cv-latex.mjs', 'generate-latex.mjs', 'mark-pdf-ready.mjs', 'jd-skill-gap.mjs', 'keyword-match.mjs', 'custom/projects/rank.mjs', 'custom/cv/build-html.mjs', 'custom/cv/render-pdf.mjs'],
  },
  outreach: {
    writeGlobs: ['data/contacts.tsv', 'data/follow-ups.md', 'data/reply-candidates.json'],
    network: ['WebFetch', 'WebSearch'],
    extraBash: ['followup-cadence.mjs', 'set-status.mjs'],
  },
  interview: {
    writeGlobs: ['interview-prep/**'],
    network: ['WebFetch', 'WebSearch'],
    extraBash: ['match-star.mjs', 'weekly-digest.mjs', 'story-provenance-check.mjs', 'salary-gap.mjs'],
  },
  offer: {
    writeGlobs: ['data/offers/**', 'data/outcomes/**', 'data/salary-observations.tsv'],
    network: [],
    extraBash: ['outcome.mjs', 'hired-share.mjs'],
  },
  profile: {
    writeGlobs: ['cv.md', 'article-digest.md', 'config/profile.yml', 'modes/_profile.md', 'data/career-profile.yml', 'data/intake-state.json'],
    network: ['WebFetch'],
    // rank.mjs --check validates article-digest.md after an edit; no PDF tooling (no output/** scope).
    extraBash: ['add-entry.mjs', 'intake.mjs', 'career-profile.mjs', 'custom/projects/rank.mjs'],
  },
  analysis: {
    writeGlobs: ['data/upskill/**'],
    network: ['WebFetch', 'WebSearch'],
    extraBash: ['analyze-patterns.mjs', 'calibrate.mjs', 'upskill.mjs', 'stats.mjs', 'funnel-velocity.mjs', 'agent-inbox.mjs'],
  },
  scan: {
    writeGlobs: ['portals.yml'],
    network: ['WebFetch', 'WebSearch'],
    extraBash: ['scan.mjs', 'validate-portals.mjs', 'verify-portals.mjs'],
  },
  apply: {
    writeGlobs: ['output/**'],
    network: [],
    extraBash: ['prepare-application.mjs', 'set-status.mjs'],
    mcp: 'playwright',
  },
  'fix-portal': {
    writeGlobs: ['portals.yml'],
    network: ['WebFetch'],
    extraBash: ['verify-portals.mjs'],
  },
  'immigration-policy': {
    // Only the pass's three outputs, as run-daily.sh allows its own pass: the queue, seen ids, batches, the pidfile and the
    // cached company verdicts under data/immigration are job state, never for a session that reads untrusted pages.
    writeGlobs: ['data/immigration/policy-changes.tsv', 'data/immigration/company-alerts.tsv', 'data/immigration/policy-digest.md'],
    network: ['WebFetch', 'WebSearch'],
    extraBash: [],
  },
  'sponsorship-check': {
    writeGlobs: ['data/immigration/companies/**', 'data/immigration/company-alerts.tsv'],
    network: ['WebFetch', 'WebSearch'],
    extraBash: ['plugins/h1b-sponsor/check.mjs', 'custom/immigration/freshness.mjs'],
  },
  'read-only': {
    writeGlobs: [],
    network: [],
    extraBash: [],
  },
  update: {
    writeGlobs: [],
    network: [],
    extraBash: [],
  },
  // Spec 4.6: the user layer plus custom/**; the supervisor and node_modules stay out of reach.
  devchat: {
    writeGlobs: [
      'cv.md',
      'article-digest.md',
      'voice-dna.md',
      'config/profile.yml',
      'config/plugins.yml',
      'config/cv-facts.json',
      'config/benchmarks.yml',
      'modes/_profile.md',
      'modes/_custom.md',
      'modes/_brief.md',
      'portals.yml',
      'data/**',
      'reports/**',
      'output/**',
      'interview-prep/**',
      'writing-samples/**',
      'jds/**',
      'documents/**',
      'custom/**',
    ],
    network: ['WebFetch', 'WebSearch'],
    extraBash: [],
    bashPrefixes: [
      ['npm', '--prefix', 'custom/control-center', 'run', 'test'],
      ['npm', '--prefix', 'custom/control-center', 'run', 'typecheck'],
      ['npm', '--prefix', 'custom/control-center', 'run', 'lint'],
      ['npm', '--prefix', 'custom/control-center', 'run', 'build'],
      ['npx', '--prefix', 'custom/control-center', 'vitest', 'run'],
      // No `node --test custom/...`: those tests import modules Dev Chat can edit, and they would run outside any guard.
      ['node', 'validate-portals.mjs'],
      ['node', 'validate-profile.mjs'],
      ['git', 'status'],
      ['git', 'diff'],
      ['git', 'log'],
    ],
  },
};

// READ_DENY (secret files under each root) and HOME_READ_DENY (home credential stores) live in confinement.mjs, which
// the daily job's policy pass imports too.
export { HOME_READ_DENY, READ_DENY } from './confinement.mjs';

/**
 * Version of the confinement a session's turns run under. Sessions created before read confinement (no
 * version, or 1) can be viewed but not resumed or forked: their transcripts may hold reads from outside the roots.
 */
export const SESSION_POLICY_VERSION = 2;

// Denied for every non Dev Chat session and the daily policy pass (enforced by the hook); lives in confinement.mjs.
export { ALWAYS_DENIED_WRITES };
/**
 * Dev Chat keeps the tracker and blacklist rules and additionally protects the
 * app's own state, the guard and its policy code, recovery, dependencies, and
 * everything its allowed npm/npx commands execute besides the app sources
 * (manifests, build and test configs, tests, scripts), and what launchd or the
 * user runs outside any session guard: the daily and weekly job scripts and
 * prompts, the launchd installer, the installer, and every custom/ test suite
 * with the helpers they all import (install.sh and the weekly sync run every
 * custom spec with node --test). Dev Chat can still edit server/**
 * and the custom modules those commands and jobs load: it is a trusted
 * code-editing agent and this list prevents accidents, it is not a sandbox
 * (README section 5).
 */
export const DEVCHAT_DENIED_WRITES = [
  ...ALWAYS_DENIED_WRITES,
  'custom/control-center/server/claude/**',
  // The core adapter and contract.json: its claude.approvedVersions is the confinement gate, and the supervisor loads both.
  'custom/control-center/server/core/**',
  'custom/control-center/supervisor/**',
  'custom/control-center/package.json',
  'custom/control-center/package-lock.json',
  'custom/control-center/vite.config.*',
  'custom/control-center/vitest.config.*',
  'custom/control-center/playwright.config.*',
  'custom/control-center/eslint.config.*',
  'custom/control-center/tsconfig*.json',
  'custom/control-center/tests/**',
  'custom/control-center/scripts/**',
  'custom/immigration/run-daily.sh',
  'custom/immigration/daily-prompt.md',
  'custom/*/tests/**',
  'custom/**/*.spec.*',
  'custom/**/*.test.*',
  'custom/test-support/**',
  'custom/install/**',
  'custom/upstream-sync/**',
  'custom/launchd/**',
  '**/node_modules/**',
  'writing-samples/README.md',
];

/** A class's write globs split by the root their files live in (CODE_ROOT_WRITE_GLOBS, in confinement.mjs). */
export function writeGlobsByRoot(globs: readonly string[]): { data: string[]; code: string[] } {
  return { data: globs.filter((g) => !CODE_ROOT_WRITE_GLOBS.includes(g)), code: globs.filter((g) => CODE_ROOT_WRITE_GLOBS.includes(g)) };
}

/** Modes that exist only inside the Control Center (no modes/*.md file). */
export const VIRTUAL_MODES: Record<string, { title: string; policyClass: PolicyClass; network?: NetworkTool[] }> = {
  advisor: { title: 'Ask (advisor)', policyClass: 'read-only' },
  'ai-search': { title: 'AI search', policyClass: 'read-only', network: ['WebSearch'] },
  research: { title: 'Portfolio research', policyClass: 'read-only', network: ['WebFetch'] },
  'cv-ingest': { title: 'CV import (PDF parse)', policyClass: 'read-only' },
  // Runs no command: the app extracts the documents/ source with intake's helpers and puts the text in the first message.
  'projects-ingest': { title: 'Projects import (PDF parse)', policyClass: 'read-only' },
  'fix-portal': { title: 'Fix portal slug', policyClass: 'fix-portal' },
  'immigration-policy': { title: 'Immigration policy pass', policyClass: 'immigration-policy' },
  'sponsorship-check': { title: 'Company sponsorship check', policyClass: 'sponsorship-check' },
  devchat: { title: 'Dev Chat (edit the user layer and custom/)', policyClass: 'devchat' },
};

const BASENAME_CLASS: Record<string, PolicyClass> = {
  'auto-pipeline': 'evaluate',
  oferta: 'evaluate',
  pipeline: 'evaluate',
  triage: 'evaluate',
  batch: 'evaluate',
  pdf: 'documents',
  text: 'documents',
  latex: 'documents',
  'latex-tex': 'documents',
  cover: 'documents',
  email: 'outreach',
  contacto: 'outreach',
  deep: 'outreach',
  followup: 'outreach',
  'reply-watch': 'outreach',
  'interview-prep': 'interview',
  'interview-redflag': 'interview',
  'offer-prep': 'offer',
  outcome: 'offer',
  interview: 'profile',
  'master-profile': 'profile',
  add: 'profile',
  expand: 'profile',
  intake: 'profile',
  titles: 'profile',
  training: 'profile',
  project: 'profile',
  patterns: 'analysis',
  calibrate: 'analysis',
  upskill: 'analysis',
  tracker: 'analysis',
  ofertas: 'analysis',
  'agent-inbox': 'analysis',
  scan: 'scan',
  discover: 'scan',
  apply: 'apply',
  update: 'update',
};

/**
 * Localized modes whose file name is translated, and the English mode each one is (their titles say so): the full
 * evaluation of one posting and the live application assistant. A localized mode named like its English mode
 * (de/pipeline, es/interview/plan) needs no entry.
 */
const TRANSLATED_MODES: Readonly<Record<string, string>> = {
  'ar/fursah': 'oferta',
  'de/angebot': 'oferta',
  'fr/offre': 'oferta',
  'hi/naukri': 'oferta',
  'id/lowongan': 'oferta',
  'it/annuncio': 'oferta',
  'ja/kyujin': 'oferta',
  'ko/gonggo': 'oferta',
  'nl/vacature': 'oferta',
  'tr/is-ilani': 'oferta',
  'ar/takdeem': 'apply',
  'de/bewerben': 'apply',
  'es/aplicar': 'apply',
  'fr/postuler': 'apply',
  'hi/aavedan': 'apply',
  'id/melamar': 'apply',
  'it/candidarsi': 'apply',
  'ja/oubo': 'apply',
  'ko/jiwon': 'apply',
  'nl/solliciteren': 'apply',
  'pl/aplikuj': 'apply',
  'pt/aplicar': 'apply',
  'tr/basvuru': 'apply',
};

const LANGUAGE_DIR = /^[a-z]{2}(-[A-Z]{2})?\//;

/**
 * The English mode a localized one stands for: its translation, or the same id under a language directory
 * (de/interview/debrief is interview/debrief). Any other id stands for itself.
 */
export function englishModeOf(id: string): string {
  if (Object.hasOwn(TRANSLATED_MODES, id)) return TRANSLATED_MODES[id]!;
  if (!LANGUAGE_DIR.test(id)) return id;
  const rest = id.replace(LANGUAGE_DIR, '');
  return MODES.some((m) => m.id === rest) ? rest : id;
}

/**
 * Policy class for a mode id (path under modes/ without .md). Localized modes
 * inherit the class of the English mode they stand for (englishModeOf), and
 * other localized ids by basename; anything unmapped is read-only, which is
 * the safe default.
 */
export function classForMode(id: string): PolicyClass {
  // Own keys only, here and below: `constructor` or `__proto__` would otherwise find Object's members.
  if (Object.hasOwn(VIRTUAL_MODES, id)) return VIRTUAL_MODES[id]!.policyClass;
  const english = englishModeOf(id);
  if (english !== id) return classForMode(english);
  if (id === 'pdf/hm-audit') return 'documents';
  if (id.startsWith('interview/') || id.endsWith('/interview-prep')) return 'interview';
  if (id.startsWith('regional/')) return 'evaluate';
  const base = id.split('/').pop() ?? id;
  return Object.hasOwn(BASENAME_CLASS, base) ? BASENAME_CLASS[base]! : 'read-only';
}

export interface ModePolicy {
  id: string;
  title: string;
  policyClass: PolicyClass;
  writeGlobs: string[];
  network: NetworkTool[];
  /** Scripts the session may run, relative to the code root. */
  scripts: string[];
  /** Permission rule strings for --allowedTools. */
  bashRules: string[];
  /** Exact token prefixes the guard hook accepts for Bash. */
  bashPrefixes: string[][];
  allowsTask: boolean;
  mcp?: 'playwright';
}

export function bashRuleFor(script: string): string {
  return script.endsWith('.sh') ? `Bash(bash ${script}:*)` : `Bash(node ${script}:*)`;
}

export function bashPrefixFor(script: string): string[] {
  return script.endsWith('.sh') ? ['bash', script] : ['node', script];
}

/** A script the mode files reference that no session may run: it starts an agent CLI outside the guard (guard-policy.mjs). */
function sessionRunnable(script: string): boolean {
  return !AGENT_SPAWNING_SCRIPTS.includes(script);
}

export function getModePolicy(id: string): ModePolicy | null {
  const derived = MODES.find((m) => m.id === id);
  const virtual = Object.hasOwn(VIRTUAL_MODES, id) ? VIRTUAL_MODES[id] : undefined;
  if (!derived && !virtual) return null;
  const policyClass = classForMode(id);
  const def = POLICY_CLASSES[policyClass];
  const scripts = [...new Set([...def.extraBash, ...(derived?.scripts ?? [])])].filter(sessionRunnable).sort();
  const explicit = def.bashPrefixes?.filter((p) => p.every(sessionRunnable));
  const bashPrefixes = explicit ?? scripts.map(bashPrefixFor);
  return {
    id,
    title: derived?.title ?? virtual!.title,
    policyClass,
    writeGlobs: [...def.writeGlobs],
    network: virtual?.network ?? [...def.network],
    scripts,
    bashRules: explicit ? explicit.map((p) => `Bash(${p.join(' ')}:*)`) : scripts.map(bashRuleFor),
    bashPrefixes,
    allowsTask: id === 'pdf/hm-audit',
    ...(def.mcp ? { mcp: def.mcp } : {}),
  };
}

/**
 * Modes that never run as a session, with the reason the app shows. Batch mode exists to run batch-runner.sh,
 * which no session may run; Pipeline > Batch evaluates the same URLs as one confined session each (manager.fanOut).
 */
const REFUSED_MODES: Readonly<Record<string, string>> = {
  batch: 'Batch mode runs batch/batch-runner.sh, whose workers are claude -p --dangerously-skip-permissions processes outside the session guard, so it never runs as a session. Use Pipeline > Batch instead: it evaluates each URL in its own confined session.',
};

/** Why `id` may not run as a session, or null when it may. */
export function sessionRefusal(id: string): string | null {
  return Object.hasOwn(REFUSED_MODES, id) ? REFUSED_MODES[id]! : null;
}

export function listModeIds(): string[] {
  return [...MODES.map((m) => m.id), ...Object.keys(VIRTUAL_MODES)].sort();
}

/** The modes New session and the palette offer: every mode but those refused as a session (their old sessions stay viewable). */
export function listLaunchableModeIds(): string[] {
  return listModeIds().filter((id) => sessionRefusal(id) === null);
}
