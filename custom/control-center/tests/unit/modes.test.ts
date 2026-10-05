import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { deriveModes } from '../../scripts/derive-mode-policies.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { ALWAYS_DENIED_WRITES, MODES, POLICY_CLASSES, VIRTUAL_MODES, classForMode, getModePolicy, listModeIds, sessionRefusal } from '../../server/claude/modes.js';
import { AGENT_SPAWNING_SCRIPTS } from '../../server/claude/guard-policy.mjs';
import { ENVELOPE_MODES } from '../../server/claude/honesty.js';

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
    expect(getModePolicy('fr/postuler')?.writeGlobs).toEqual(['output/**']);
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

  it('projects-ingest is a read-only virtual mode whose turn ends in an envelope', () => {
    const p = getModePolicy('projects-ingest');
    expect(p?.policyClass).toBe('read-only');
    expect(p?.writeGlobs).toEqual([]);
    expect(ENVELOPE_MODES.has('projects-ingest')).toBe(true);
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
    for (const id of listModeIds().filter((m) => m !== 'batch')) expect(sessionRefusal(id), id).toBeNull();
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

  it('no class ever grants the always-denied files', () => {
    for (const [name, def] of Object.entries(POLICY_CLASSES)) {
      for (const denied of ALWAYS_DENIED_WRITES) {
        expect(def.writeGlobs, `${name} grants ${denied}`).not.toContain(denied);
      }
    }
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
