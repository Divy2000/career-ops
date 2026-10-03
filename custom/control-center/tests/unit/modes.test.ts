import { describe, expect, it } from 'vitest';
import { deriveModes } from '../../scripts/derive-mode-policies.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { ALWAYS_DENIED_WRITES, MODES, POLICY_CLASSES, VIRTUAL_MODES, classForMode, getModePolicy, listModeIds } from '../../server/claude/modes.js';

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

  it('every discovered mode has a policy class and every script it references is in its Bash allowlist', () => {
    for (const mode of MODES) {
      const policy = getModePolicy(mode.id);
      expect(policy, mode.id).not.toBeNull();
      expect(Object.keys(POLICY_CLASSES)).toContain(policy!.policyClass);
      for (const script of mode.scripts) {
        expect(policy!.scripts, `${mode.id} references ${script}`).toContain(script);
        expect(policy!.bashRules.some((r) => r.includes(` ${script}:*)`)), `${mode.id} rule for ${script}`).toBe(true);
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

  it('virtual modes exist and the read-only class grants no writes', () => {
    for (const id of Object.keys(VIRTUAL_MODES)) expect(getModePolicy(id)).not.toBeNull();
    expect(getModePolicy('advisor')?.writeGlobs).toEqual([]);
    expect(getModePolicy('ai-search')?.network).toEqual(['WebSearch']);
    expect(listModeIds()).toContain('sponsorship-check');
  });

  it('no class ever grants the always-denied files', () => {
    for (const [name, def] of Object.entries(POLICY_CLASSES)) {
      for (const denied of ALWAYS_DENIED_WRITES) {
        expect(def.writeGlobs, `${name} grants ${denied}`).not.toContain(denied);
      }
    }
  });
});
