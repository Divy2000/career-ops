import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { THEME_MODES, useTheme, type ResolvedTheme, type ThemeMode } from '../lib/theme';

export const THEME_OPTIONS: Record<ThemeMode, { label: string; hint: string; Icon: LucideIcon }> = {
  auto: { label: 'Auto', hint: 'Follows your system', Icon: Monitor },
  light: { label: 'Light', hint: 'Porcelain studio', Icon: Sun },
  dark: { label: 'Dark', hint: 'Midnight console', Icon: Moon },
};

/** "Theme: Auto (dark)": Auto names what it currently resolves to, so the state is never color-only. */
export function themeName(mode: ThemeMode, resolved: ResolvedTheme): string {
  return mode === 'auto' ? `Theme: Auto (${resolved})` : `Theme: ${THEME_OPTIONS[mode].label}`;
}

/** Gradient paint for the trigger icon, defined once; the stops read the theme's own tokens. */
function BrandGradientDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" className="theme-switch__defs">
      <defs>
        <linearGradient id="cc-brand-stroke" gradientUnits="userSpaceOnUse" x1="2" y1="2" x2="22" y2="22">
          <stop offset="0" style={{ stopColor: 'var(--accent)' }} />
          <stop offset="1" style={{ stopColor: 'var(--accent-2)' }} />
        </linearGradient>
      </defs>
    </svg>
  );
}

/**
 * WAI-ARIA menu button with three menuitemradio choices. It is deliberately not a dialog, so the Shell's
 * "another modal is open" check and its focus rescue never see it.
 */
export function ThemeSwitcher() {
  const { mode, resolved, setMode } = useTheme();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Which item takes focus once the menu has rendered.
  const [focusIndex, setFocusIndex] = useState(0);

  const openAt = (index: number) => {
    setFocusIndex(index);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const checked = THEME_MODES.indexOf(mode);

  useEffect(() => {
    if (open) itemRefs.current[focusIndex]?.focus();
  }, [open, focusIndex]);

  useEffect(() => {
    if (!open) return;
    const onPress = (e: Event) => {
      if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPress);
    return () => document.removeEventListener('pointerdown', onPress);
  }, [open]);

  const onTriggerKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') openAt(checked);
    else if (e.key === 'ArrowUp') openAt(THEME_MODES.length - 1);
    else return;
    e.preventDefault();
  };

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const last = THEME_MODES.length - 1;
    const here = itemRefs.current.findIndex((el) => el === document.activeElement);
    const move = (to: number) => {
      e.preventDefault();
      itemRefs.current[to]?.focus();
    };
    switch (e.key) {
      case 'ArrowDown':
        return move(here >= last ? 0 : here + 1);
      case 'ArrowUp':
        return move(here <= 0 ? last : here - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(last);
      case 'Escape':
        // Not the drawer's or the overlays' Escape: this one only closes the menu.
        e.preventDefault();
        e.stopPropagation();
        return close();
      case 'Tab':
        // Focus goes back to the trigger first, so the default Tab moves on from there instead of from a menu that is about to unmount.
        setOpen(false);
        triggerRef.current?.focus();
    }
  };

  const Icon = THEME_OPTIONS[resolved === 'dark' ? 'dark' : 'light'].Icon;
  const name = themeName(mode, resolved);
  return (
    <div className="theme-switch" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="theme-switch__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={name}
        data-mode={mode}
        onClick={() => (open ? setOpen(false) : openAt(checked))}
        onKeyDown={onTriggerKey}
      >
        <BrandGradientDefs />
        <span className="theme-switch__icon" key={resolved} aria-hidden="true">
          <Icon size={18} strokeWidth={2} />
        </span>
        <span className="sr-only">{name}</span>
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label="Theme" className="theme-menu" onKeyDown={onMenuKey}>
          {THEME_MODES.map((m, i) => {
            const { label, hint, Icon: ItemIcon } = THEME_OPTIONS[m];
            return (
              <button
                key={m}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={m === mode}
                tabIndex={-1}
                className="theme-menu__item"
                title={hint}
                onClick={() => {
                  setMode(m, triggerRef.current ?? undefined);
                  close();
                }}
              >
                <ItemIcon size={16} aria-hidden="true" />
                <span className="theme-menu__label">{label}</span>
                {m === mode && <Check size={16} aria-hidden="true" className="theme-menu__check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
