import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { deriveModes } from '../../scripts/derive-mode-policies.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { ALWAYS_DENIED_WRITES, DEVCHAT_DENIED_WRITES, MODES, POLICY_CLASSES, VIRTUAL_MODES, classForMode, getModePolicy, listLaunchableModeIds, listModeIds, sessionRefusal } from '../../server/claude/modes.js';
import { AGENT_SPAWNING_SCRIPTS, matches } from '../../server/claude/guard-policy.mjs';
import { TERMINAL_ENVELOPE_KINDS } from '../../server/claude/honesty.js';
import { checkWrite } from '../../server/claude/guard-policy.mjs';
import { writePolicyFile } from '../../server/claude/invocation.js';
import { tempDir } from '../helpers/tmp.js';

describe('mode registry', () => {
  it('the frozen snapshot matches the modes/ tree (a mode appeared, vanished or changed its script references)', () => {
    expect(deriveModes(DEFAULT_CODE_ROOT)).toEqual(MODES);
  });

  it('discovers the top-level English modes and the nested ones', () => {
    const ids = MODES.map((m) => m.id);
    for (const id of ['oferta', 'auto-pipeline', 'apply', 'pdf', 'pdf/hm-audit', 'interview/plan', 'regional/eu-swe', 'tracker']) {
      expect(ids).toContain(id);
    }
    expect(ids.some((id) => id.startsWith('_'))).toBe(false);
    expect(ids.some((id) => /readme$/i.test(id))).toBe(false);
  });

  it('every discovered mode has a policy class and every script it references is in its Bash allowlist, except the agent-spawning ones', () => {
    for (const mode of MODES) {
      const policy = getModePolicy(mode.id);
      expect(policy, mode.id).not.toBeNull();
      expect(Object.keys(POLICY_CLASSES)).toContain(policy!.policyClass);
      for (const script of mode.scripts) {
        const granted = !AGENT_SPAWNING_SCRIPTS.includes(script);
        expect(policy!.scripts.includes(script), `${mode.id} references ${script}`).toBe(granted);
        expect(policy!.bashRules.some((r) => r.includes(` ${script}:*)`)), `${mode.id} rule for ${script}`).toBe(granted);
      }
    }
  });

  it('maps the spec table: evaluate, documents, apply with Playwright, hm-audit with Task', () => {
    expect(classForMode('oferta')).toBe('evaluate');
    expect(classForMode('auto-pipeline')).toBe('evaluate');
    expect(classForMode('cover')).toBe('documents');
    expect(classForMode('interview')).toBe('profile');
    expect(classForMode('interview/practice')).toBe('interview');
    expect(classForMode('regional/eu-swe')).toBe('evaluate');
    expect(getModePolicy('apply')?.mcp).toBe('playwright');
    expect(getModePolicy('pdf/hm-audit')?.allowsTask).toBe(true);
    expect(getModePolicy('pdf')?.allowsTask).toBe(false);
    expect(getModePolicy('oferta')?.writeGlobs).toContain('reports/**');
    expect(getModePolicy('oferta')?.scripts).toContain('custom/immigration/freshness.mjs');
  });

  it('localized modes inherit by basename and unknown ones fall back to read-only', () => {
    expect(classForMode('de/pipeline')).toBe('evaluate');
    expect(classForMode('heuristics/recruiter-side')).toBe('read-only');
    expect(classForMode('no-such-mode')).toBe('read-only');
    expect(getModePolicy('no-such-mode')).toBeNull();
  });

  it('a localized mode runs under the class of the English mode it translates, nested interview modes and translated names included', () => {
    // The translated evaluation (A-F/A-G) and live-application modes, as their titles say.
    const translated: Record<string, string> = {
      'ar/fursah': 'oferta', 'de/angebot': 'oferta', 'fr/offre': 'oferta', 'hi/naukri': 'oferta', 'id/lowongan': 'oferta', 'it/annuncio': 'oferta', 'ja/kyujin': 'oferta', 'ko/gonggo': 'oferta', 'nl/vacature': 'oferta', 'tr/is-ilani': 'oferta',
      'ar/takdeem': 'apply', 'de/bewerben': 'apply', 'es/aplicar': 'apply', 'fr/postuler': 'apply', 'hi/aavedan': 'apply', 'id/melamar': 'apply', 'it/candidarsi': 'apply', 'ja/oubo': 'apply', 'ko/jiwon': 'apply', 'nl/solliciteren': 'apply', 'pl/aplikuj': 'apply', 'pt/aplicar': 'apply', 'tr/basvuru': 'apply',
    };
    for (const [id, en] of Object.entries(translated)) {
      expect(MODES.some((m) => m.id === id), id).toBe(true);
      expect(classForMode(id), id).toBe(classForMode(en));
    }
    for (const lang of ['de', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'pt', 'ru', 'ua', 'zh']) for (const sub of ['debrief', 'plan', 'practice']) expect(classForMode(`${lang}/interview/${sub}`), `${lang}/interview/${sub}`).toBe('interview');
    expect(getModePolicy('de/angebot')?.writeGlobs).toContain('reports/**');
    expect(getModePolicy('fr/postuler')?.writeGlobs).toEqual(['output/**', 'reports/*.md']);
    // Every mode under a language folder is either the English mode under the same name or a translation listed above,
    // so a new localized mode that is neither fails here instead of silently running read-only.
    for (const m of MODES) {
      const [lang, ...rest] = m.id.split('/');
      if (rest.length === 0 || !/^[a-z]{2}(-[A-Z]{2})?$/.test(lang!)) continue;
      const en = rest.join('/');
      const counterpart = MODES.some((e) => e.id === en) ? en : translated[m.id];
      expect(counterpart, `${m.id} has no English counterpart`).toBeDefined();
      expect(classForMode(m.id), m.id).toBe(classForMode(counterpart!));
    }
  });

  it('a mode id named after an Object property is no mode, and its class is the read-only default', () => {
    for (const id of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(getModePolicy(id), id).toBeNull();
      expect(classForMode(id), id).toBe('read-only');
      expect(classForMode(`de/${id}`), id).toBe('read-only');
    }
  });

  it('virtual modes exist and the read-only class grants no writes', () => {
    for (const id of Object.keys(VIRTUAL_MODES)) expect(getModePolicy(id)).not.toBeNull();
    expect(getModePolicy('advisor')?.writeGlobs).toEqual([]);
    expect(getModePolicy('ai-search')?.network).toEqual(['WebSearch']);
    expect(listModeIds()).toContain('sponsorship-check');
  });

  it('projects library: rank.mjs in evaluate, documents and profile sessions; the fork CV build and render where PDFs are written', () => {
    for (const mode of ['oferta', 'pdf', 'master-profile']) expect(getModePolicy(mode)?.scripts, mode).toContain('custom/projects/rank.mjs');
    for (const mode of ['oferta', 'pdf', 'cover']) {
      expect(getModePolicy(mode)?.scripts, mode).toContain('custom/cv/build-html.mjs');
      expect(getModePolicy(mode)?.scripts, mode).toContain('custom/cv/render-pdf.mjs');
    }
    // A profile session cannot write output/**, so a PDF render there could only fail.
    expect(getModePolicy('master-profile')?.scripts).not.toContain('custom/cv/render-pdf.mjs');
  });

  it('latex and latex-tex sessions may run the sandboxed compile wrapper their modes are redirected to (generate-latex.mjs compiles are refused)', () => {
    for (const mode of ['latex', 'latex-tex']) expect(getModePolicy(mode)?.bashPrefixes, mode).toContainEqual(['node', 'custom/cv/compile-latex.mjs']);
  });

  it('the documents class grants the JD file its modes write: pdf.md\'s jds/{slug}.md, which the projects house rule ranks for pdf, text, latex and cover (SW3-libs-01)', () => {
    expect(fs.readFileSync(path.join(DEFAULT_CODE_ROOT, 'modes', 'pdf.md'), 'utf8')).toContain('write the JD to `jds/{slug}.md` first');
    const houseRule = fs.readFileSync(path.join(DEFAULT_CODE_ROOT, 'custom', 'install', 'templates', '_custom-projects.md'), 'utf8');
    expect(houseRule).toContain('after the JD is saved under `jds/`, run `node custom/projects/rank.mjs jds/<slug>.md --json`');
    for (const mode of ['pdf', 'text', 'latex', 'latex-tex', 'cover']) {
      const policy = getModePolicy(mode)!;
      expect(policy.policyClass, mode).toBe('documents');
      expect(matches('jds/acme-backend.md', policy.writeGlobs), mode).toBe(true);
      expect(policy.scripts, mode).toContain('custom/projects/rank.mjs');
    }
  });

  it('projects-ingest is a read-only virtual mode whose turn ends in an envelope', () => {
    const p = getModePolicy('projects-ingest');
    expect(p?.policyClass).toBe('read-only');
    expect(p?.writeGlobs).toEqual([]);
    expect(TERMINAL_ENVELOPE_KINDS['projects-ingest']).toBe('projects');
  });

  it('projects-ingest runs no command at all: the app hands it the extracted text', () => {
    expect(getModePolicy('projects-ingest')?.scripts).toEqual([]);
    expect(getModePolicy('projects-ingest')?.bashRules).toEqual([]);
  });

  it('no session policy grants a script that starts an agent CLI: not in its scripts, Bash rules or Bash prefixes', () => {
    expect(AGENT_SPAWNING_SCRIPTS).toEqual(['batch/batch-runner.sh', 'rank-pipeline.mjs']);
    // The modes tree references both, so the derived lists alone would grant them.
    expect(MODES.find((m) => m.id === 'batch')?.scripts).toContain('batch/batch-runner.sh');
    expect(MODES.find((m) => m.id === 'pipeline')?.scripts).toContain('rank-pipeline.mjs');
    for (const id of listModeIds()) {
      const p = getModePolicy(id)!;
      for (const script of AGENT_SPAWNING_SCRIPTS) {
        expect(p.scripts, `${id} scripts`).not.toContain(script);
        expect(p.bashRules.some((r) => r.includes(script)), `${id} rules`).toBe(false);
        expect(p.bashPrefixes.some((b) => b.includes(script)), `${id} prefixes`).toBe(false);
      }
    }
  });

  it('batch mode is refused as a session with a reason that points at Pipeline > Batch; every other mode is not', () => {
    expect(sessionRefusal('batch')).toMatch(/batch-runner\.sh/);
    expect(sessionRefusal('batch')).toMatch(/Pipeline > Batch/);
    for (const id of listModeIds().filter((m) => m !== 'batch' && m !== 'update')) expect(sessionRefusal(id), id).toBeNull();
  });

  it('update mode is refused as a session because apply/rollback commit upstream code outside the guard (R18-claude-L3-01)', () => {
    expect(sessionRefusal('update')).toMatch(/update-system\.mjs apply/);
    expect(sessionRefusal('update')).toMatch(/upstream-sync PR/);
    expect(listLaunchableModeIds()).toEqual(expect.not.arrayContaining(['update']));
  });

  it('every script a session may run was audited: none that starts an agent CLI is granted unless reviewed', () => {
    // A module that can spawn a process and names an agent CLI (or skips its permissions) could run an agent outside the guard.
    const AGENT = /dangerously-skip-permissions|['"`](claude|codex|opencode|gemini|qwen|ollama|copilot|kimi|grok|hermes|antigravity)['"`\s]/;
    // Reviewed by hand: names the CLIs only to read their config files and spawns nothing but git.
    const REVIEWED: Record<string, string> = { 'doctor.mjs': 'spawns only git' };
    const granted = [...new Set(listModeIds().flatMap((id) => getModePolicy(id)!.scripts))];
    const flagged = granted.filter((script) => importGraph(script).some((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return (file.endsWith('.sh') || /child_process/.test(text)) && AGENT.test(text);
    }));
    expect(flagged.filter((s) => !REVIEWED[s])).toEqual([]);
    // The audit does see a spawner: the forbidden scripts would be flagged if a mode granted them.
    for (const script of AGENT_SPAWNING_SCRIPTS) expect(importGraph(script).some((f) => AGENT.test(fs.readFileSync(f, 'utf8'))), script).toBe(true);
  });

  it('no class ever grants the always-denied files, not even through a wider glob', () => {
    // A file each denied entry covers: the entry itself, or one inside a denied folder glob.
    const deniedFiles = ALWAYS_DENIED_WRITES.map((denied) => denied.replace('**', 'state/probe.json'));
    for (const [name, def] of Object.entries(POLICY_CLASSES)) {
      // Dev Chat grants data/** on purpose and keeps these files out through its own deny list.
      if (name === 'devchat') continue;
      for (const file of deniedFiles) expect(matches(file, def.writeGlobs), `${name} grants ${file}`).toBe(false);
      // And no grant reaches inside a denied folder.
      for (const glob of def.writeGlobs) expect(matches(glob.replace(/\*+/g, 'probe'), ALWAYS_DENIED_WRITES), `${name} grants ${glob}`).toBe(false);
    }
    expect(DEVCHAT_DENIED_WRITES).toEqual(expect.arrayContaining(ALWAYS_DENIED_WRITES));
  });
});

/** A script and every module it imports by relative path, as files under the code root. */
function importGraph(script: string): string[] {
  const seen = new Set<string>();
  const stack = [path.join(DEFAULT_CODE_ROOT, script)];
  const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    if (file.endsWith('.sh')) continue;
    for (const m of fs.readFileSync(file, 'utf8').matchAll(IMPORT)) stack.push(path.resolve(path.dirname(file), m[1]!));
  }
  return [...seen];
}

describe('evaluation sessions record the desired ask (R20-claude-L2-01)', () => {
  it('given modes/oferta.md section 3, when an oferta, auto-pipeline or localized oferta session appends the desired line, then the guard lets it write data/salary-observations.tsv', () => {
    expect(fs.readFileSync(path.join(DEFAULT_CODE_ROOT, 'modes', 'oferta.md'), 'utf8')).toContain('append one `desired` line (source `user`) to `data/salary-observations.tsv`');
    const root = fs.realpathSync(tempDir('cc-salary-obs-'));
    for (const mode of ['oferta', 'auto-pipeline', 'de/angebot']) {
      const policy = getModePolicy(mode)!;
      expect(policy.policyClass, mode).toBe('evaluate');
      const pf = writePolicyFile(path.join(root, 'guard', mode.replace('/', '-')), { codeRoot: root, dataRoot: root, policy, deny: [...ALWAYS_DENIED_WRITES] });
      const written = JSON.parse(fs.readFileSync(pf.file, 'utf8')) as Parameters<typeof checkWrite>[0];
      expect(checkWrite(written, 'Edit', path.join(root, 'data', 'salary-observations.tsv')), mode).toBeNull();
    }
  });

  it('given an evaluate-class mode that never asks for a number, when it writes the observations log, then it is refused', () => {
    expect(matches('data/salary-observations.tsv', getModePolicy('triage')!.writeGlobs)).toBe(false);
  });
});

describe('derive-mode-policies CLI', () => {
  // Node realpaths the ESM entry for import.meta.url but argv[1] keeps the spelling typed, so a run through a symlinked
  // checkout must still write the snapshot instead of exiting 0 having done nothing (R30-supervisor-X-01).
  it('writes the snapshot when run through a symlinked checkout', () => {
    const real = tempDir('derive-modes-');
    const repo = path.join(real, 'repo');
    const scripts = path.join(repo, 'custom', 'control-center', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../scripts/derive-mode-policies.ts'), path.join(scripts, 'derive-mode-policies.ts'));
    fs.mkdirSync(path.join(repo, 'lib'));
    fs.copyFileSync(path.join(DEFAULT_CODE_ROOT, 'lib', 'is-main-module.mjs'), path.join(repo, 'lib', 'is-main-module.mjs'));
    fs.mkdirSync(path.join(repo, 'modes'));
    fs.writeFileSync(path.join(repo, 'modes', 'demo.md'), '# Demo mode\n');
    const link = path.join(real, 'link');
    fs.symlinkSync(repo, link);
    // tsx keeps a compile cache under TMPDIR; inside the temp dir it goes with it.
    const tsx = path.resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs');
    const r = spawnSync(process.execPath, [tsx, path.join(link, 'custom', 'control-center', 'scripts', 'derive-mode-policies.ts')], { cwd: real, encoding: 'utf8', env: { ...process.env, TMPDIR: real } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('wrote 1 modes');
    const out = JSON.parse(fs.readFileSync(path.join(repo, 'custom', 'control-center', 'server', 'claude', 'modes.generated.json'), 'utf8'));
    expect(out).toEqual([{ id: 'demo', file: 'modes/demo.md', title: 'Demo mode', scripts: [], paths: [] }]);
  });
});
