import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { THEME_MODES, useTheme, type ThemeMode } from '../lib/theme';
import { THEME_OPTIONS } from './ThemeSwitcher';

/** A miniature of the app drawn under its own data-theme, so each preview shows that theme's real tokens. */
function Mock({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <span className="theme-preview__mock" data-theme={theme}>
      <span className="tp-side">
        <i className="tp-brand" />
        <i className="tp-nav tp-nav--on" />
        <i className="tp-nav" />
        <i className="tp-nav" />
      </span>
      <span className="tp-main">
        <i className="tp-title" />
        <span className="tp-card">
          <i className="tp-line" />
          <i className="tp-line tp-line--short" />
          <span className="tp-row">
            <i className="tp-chip" />
            <i className="tp-btn" />
          </span>
        </span>
      </span>
    </span>
  );
}

function Preview({ mode }: { mode: ThemeMode }) {
  return (
    <span className={`theme-preview${mode === 'auto' ? ' theme-preview--auto' : ''}`} aria-hidden="true">
      {mode === 'auto' ? (
        <>
          <Mock theme="light" />
          <Mock theme="dark" />
        </>
      ) : (
        <Mock theme={mode} />
      )}
    </span>
  );
}

/** Settings > App > Appearance: a radiogroup of preview cards with roving focus (arrows select, like native radios). */
export function AppearanceSetting() {
  const { mode, setMode } = useTheme();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: ReactKeyboardEvent, index: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + THEME_MODES.length) % THEME_MODES.length;
    const el = refs.current[next];
    el?.focus();
    setMode(THEME_MODES[next]!, el ?? undefined);
  };
  return (
    <div className="fields__row">
      <div className="fields__label">
        Appearance
        <span className="faint small">Auto follows your system and switches live. Light and Dark stay put until you change them.</span>
      </div>
      <div className="fields__value">
        <div className="theme-cards" role="radiogroup" aria-label="Appearance">
          {THEME_MODES.map((m, i) => (
            <button
              key={m}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={m === mode}
              aria-label={THEME_OPTIONS[m].label}
              tabIndex={m === mode ? 0 : -1}
              className="theme-card"
              onClick={(e) => setMode(m, e.currentTarget)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <Preview mode={m} />
              <span className="theme-card__label" aria-hidden="true">
                {THEME_OPTIONS[m].label}
                {m === mode && <Check size={14} className="theme-card__check" />}
              </span>
              <span className="theme-card__hint faint small" aria-hidden="true">
                {THEME_OPTIONS[m].hint}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
