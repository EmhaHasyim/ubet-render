/**
 * Theme persistence and toggling utilities.
 *
 * Theme preference is intentionally stored under a *separate* localStorage
 * key (`ubetrender-theme`) instead of being added to {@link PersistedConfig}.
 * Rationale:
 *   - UI cosmetics should never trigger a migration of `STORAGE_VERSION`
 *     when the underlying render-engine schema has not changed.
 *   - Theme is purely a render-time concern; it never reaches the Rust
 *     backend, so it doesn't need to be round-tripped through `save_config`.
 *
 * The DaisyUI theme name is mirrored verbatim onto `document.documentElement`'s
 * `data-theme` attribute. DaisyUI itself watches that attribute and swaps
 * the CSS variables automatically.
 */

import { safeSetStorageItem } from './storage';

export type Theme = 'business' | 'light';

/** localStorage key for the theme (kept out of PersistedConfig on purpose — see above). */
const THEME_STORAGE_KEY = 'ubetrender-theme';

/**
 * Load the user's preferred theme. Falls back to the OS `prefers-color-scheme`
 * media query on first launch and to `'business'` (dark) thereafter.
 *
 * Called from a SolidJS component's `onMount` so it doesn't run in SSR.
 */
export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'business' || v === 'light') return v;
  } catch {
    /* localStorage disabled */
  }
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
  ) {
    return 'light';
  }
  return 'business';
}

/** Apply the theme to the DOM and persist the selection. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  safeSetStorageItem(THEME_STORAGE_KEY, theme);
}

/** Toggle between the two shipped themes. */
export function toggleTheme(current: Theme): Theme {
  return current === 'business' ? 'light' : 'business';
}
