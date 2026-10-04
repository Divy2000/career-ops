/** Rendered means not display:none, not inside a hidden ancestor and not visibility:hidden. */
export function isRendered(el: Element | null | undefined): el is HTMLElement {
  return el instanceof HTMLElement && el.checkVisibility({ checkVisibilityCSS: true });
}

/** Two frames: long enough for a closing Radix dialog to hand focus back to its opener first. Returns a cancel function. */
export function afterFocusSettles(run: () => void): () => void {
  let second = 0;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(run);
  });
  return () => {
    cancelAnimationFrame(first);
    cancelAnimationFrame(second);
  };
}
