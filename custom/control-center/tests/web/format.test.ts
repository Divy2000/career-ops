import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatCount } from '../../web/lib/format';

const WEB_LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'lib');

describe('formatCount', () => {
  it('groups thousands with commas in en-US', () => {
    expect(formatCount(66934)).toBe('66,934');
    expect(formatCount(1234567)).toBe('1,234,567');
  });
  it('leaves numbers below a thousand and zero untouched', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
  });
  it('does not depend on the process locale', () => {
    // A child process in a German locale, where the default number format groups with dots (SW3-tests-14).
    const code = `const { formatCount } = await import(${JSON.stringify(path.join(WEB_LIB, 'format.ts'))}); process.stdout.write(JSON.stringify([new Intl.NumberFormat().format(1000), formatCount(1000)]));`;
    // --experimental-strip-types: the Node versions the package allows (22.6 and up) import the .ts helper with it.
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { env: { ...process.env, LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' }, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const [localeDefault, formatted] = JSON.parse(run.stdout) as [string, string];
    expect(localeDefault).toBe('1.000');
    expect(formatted).toBe('1,000');
  });
});
