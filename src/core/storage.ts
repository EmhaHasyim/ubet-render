/**
 * Shared quota-safe {@link localStorage.setItem} wrapper.
 *
 * Used by {@link PersistedConfig}, {@link usePersistedConfig}, and
 * {@link applyTheme}.  Replaces three identical try/catch blocks
 * scattered across three modules with a single helper.
 */
export function safeSetStorageItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota exceeded / storage disabled */
  }
}
