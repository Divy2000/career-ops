// Mode registry and policy classes (spec section 4.2). The derived snapshot in
// modes.generated.json is produced by scripts/derive-mode-policies.ts and
// frozen; tests/unit/modes.test.ts fails when the modes/ tree drifts from it.
import generated from './modes.generated.json' with { type: 'json' };

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
  | 'update';

export type NetworkTool = 'WebFetch' | 'WebSearch';

export interface PolicyClassDef {
  writeGlobs: string[];
  network: NetworkTool[];
  /** Scripts (relative to the code root) the class may run with Bash. */
  extraBash: string[];
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
    ],
  },
  documents: {
    writeGlobs: ['output/**', 'templates/cv-*.html', 'templates/cover-*.html', '*.tex'],
    network: ['WebSearch'],
    extraBash: ['generate-pdf.mjs', 'generate-cover-letter.mjs', 'build-cv-latex.mjs', 'generate-latex.mjs', 'mark-pdf-ready.mjs', 'jd-skill-gap.mjs', 'keyword-match.mjs'],
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
    extraBash: ['add-entry.mjs', 'intake.mjs', 'career-profile.mjs'],
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
    writeGlobs: ['data/immigration/**'],
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
};

/** Denied for every non Dev Chat session, regardless of class (enforced by the hook). */
export const ALWAYS_DENIED_WRITES = ['data/blacklist.md', 'data/applications.md', 'applications.md'];

/** Modes that exist only inside the Control Center (no modes/*.md file). */
export const VIRTUAL_MODES: Record<string, { title: string; policyClass: PolicyClass; network?: NetworkTool[] }> = {
  advisor: { title: 'Ask (advisor)', policyClass: 'read-only' },
  'ai-search': { title: 'AI search', policyClass: 'read-only', network: ['WebSearch'] },
  research: { title: 'Portfolio research', policyClass: 'read-only', network: ['WebFetch'] },
  'cv-ingest': { title: 'CV import (PDF/DOCX parse)', policyClass: 'read-only' },
  'fix-portal': { title: 'Fix portal slug', policyClass: 'fix-portal' },
  'immigration-policy': { title: 'Immigration policy pass', policyClass: 'immigration-policy' },
  'sponsorship-check': { title: 'Company sponsorship check', policyClass: 'sponsorship-check' },
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
 * Policy class for a mode id (path under modes/ without .md). Localized modes
 * under language directories inherit by basename when the English mode exists;
 * anything unmapped is read-only, which is the safe default.
 */
export function classForMode(id: string): PolicyClass {
  if (id in VIRTUAL_MODES) return VIRTUAL_MODES[id]!.policyClass;
  if (id === 'pdf/hm-audit') return 'documents';
  if (id.startsWith('interview/') || id.endsWith('/interview-prep')) return 'interview';
  if (id.startsWith('regional/')) return 'evaluate';
  const base = id.split('/').pop() ?? id;
  return BASENAME_CLASS[base] ?? 'read-only';
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
  allowsTask: boolean;
  mcp?: 'playwright';
}

export function bashRuleFor(script: string): string {
  return script.endsWith('.sh') ? `Bash(bash ${script}:*)` : `Bash(node ${script}:*)`;
}

export function getModePolicy(id: string): ModePolicy | null {
  const derived = MODES.find((m) => m.id === id);
  const virtual = VIRTUAL_MODES[id];
  if (!derived && !virtual) return null;
  const policyClass = classForMode(id);
  const def = POLICY_CLASSES[policyClass];
  const scripts = [...new Set([...def.extraBash, ...(derived?.scripts ?? [])])].sort();
  return {
    id,
    title: derived?.title ?? virtual!.title,
    policyClass,
    writeGlobs: [...def.writeGlobs],
    network: virtual?.network ?? [...def.network],
    scripts,
    bashRules: scripts.map(bashRuleFor),
    allowsTask: id === 'pdf/hm-audit',
    ...(def.mcp ? { mcp: def.mcp } : {}),
  };
}

export function listModeIds(): string[] {
  return [...MODES.map((m) => m.id), ...Object.keys(VIRTUAL_MODES)].sort();
}
