import { afterEach, describe, expect, it } from 'vitest';
import { PAGE_THEME_CSS } from '../../supervisor/page-theme';
import { RECOVERY_CSS } from '../../supervisor/recovery-css';

describe('the recovery page styles', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  // The script disables every button while a revert or restart runs; one that looks enabled invites clicks that do nothing.
  it('a disabled button looks disabled: muted, faded and with a not-allowed cursor (R20-supervisor-L3-02)', () => {
    document.head.innerHTML = `<style>${PAGE_THEME_CSS}${RECOVERY_CSS}</style>`;
    document.body.innerHTML = '<form data-cc="revert"><button>Revert file</button></form>';
    const button = document.querySelector('button')!;
    const style = getComputedStyle(button);
    const enabled = { cursor: style.cursor, opacity: style.opacity, color: style.color };
    button.disabled = true;
    const disabled = getComputedStyle(button);
    expect(enabled.cursor).toBe('pointer');
    expect(disabled.cursor).toBe('not-allowed');
    expect(disabled.opacity).not.toBe(enabled.opacity);
    expect(disabled.color).not.toBe(enabled.color);
  });

  it('the disabled rule is a top-level rule, so it holds in the dark and the light theme alike', () => {
    document.head.innerHTML = `<style>${PAGE_THEME_CSS}${RECOVERY_CSS}</style>`;
    const rules = [...document.styleSheets[0]!.cssRules];
    expect(rules.some((r) => r instanceof CSSStyleRule && r.selectorText === 'button:disabled')).toBe(true);
    const nested = rules.filter((r): r is CSSMediaRule => r instanceof CSSMediaRule).flatMap((m) => [...m.cssRules]);
    expect(nested.some((r) => r instanceof CSSStyleRule && r.selectorText.includes(':disabled'))).toBe(false);
  });
});
