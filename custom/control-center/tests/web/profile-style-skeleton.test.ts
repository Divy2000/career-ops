// Settings > Profile > Add style inserts this skeleton as is. Every style token theme-style.mjs maps becomes a CSS
// override in the generated CV and cover letter, so a seeded value (the example file's #2563eb) recolors every PDF the
// user makes after merely adding the section. The skeleton must keep the built-in look (SW6-web-b-02).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PROFILE_SECTIONS } from '@web/features/settings/ProfileForm';

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('the style skeleton', () => {
  it('overrides no theme token, so adding the section changes no PDF', () => {
    const style = PROFILE_SECTIONS.find((s) => s.key === 'style')!.empty;
    const script = `import { styleTokensFrom } from ${JSON.stringify(path.join(CODE_ROOT, 'theme-style.mjs'))};
process.stdout.write(JSON.stringify(styleTokensFrom(${JSON.stringify(style)})));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toEqual({});
  });
});
