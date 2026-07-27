import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyTheme, loadTheme, THEME_STORAGE_KEY, toggleTheme } from './theme';

const KEY = THEME_STORAGE_KEY;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  // Reset matchMedia so the deterministic-defaults tests aren't affected
  // by the OS-friendly default path.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addListener: () => {},
      removeListener: () => {},
    })),
  );
});

describe('loadTheme', () => {
  it('returns "business" when nothing is stored and prefers dark', () => {
    expect(loadTheme()).toBe('business');
  });

  it('returns stored value when valid', () => {
    localStorage.setItem(KEY, 'light');
    expect(loadTheme()).toBe('light');
    localStorage.setItem(KEY, 'business');
    expect(loadTheme()).toBe('business');
  });

  it('ignores garbage / unknown values', () => {
    localStorage.setItem(KEY, 'midnight');
    expect(loadTheme()).toBe('business');
  });

  it('returns "light" when OS prefers-color-scheme: light and nothing stored', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addListener: () => {},
        removeListener: () => {},
      })),
    );
    expect(loadTheme()).toBe('light');
  });

  it('prefers explicit user selection over OS preference', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addListener: () => {},
        removeListener: () => {},
      })),
    );
    localStorage.setItem(KEY, 'business');
    expect(loadTheme()).toBe('business');
  });
});

describe('applyTheme', () => {
  it('writes data-theme to <html>', () => {
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('persists to localStorage', () => {
    applyTheme('light');
    expect(localStorage.getItem(KEY)).toBe('light');
    applyTheme('business');
    expect(localStorage.getItem(KEY)).toBe('business');
  });

  it('is a no-op-ish when localStorage throws', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceeded');
    };
    expect(() => applyTheme('light')).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    Storage.prototype.setItem = original;
  });
});

describe('toggleTheme', () => {
  it('cycles business -> light -> business', () => {
    expect(toggleTheme('business')).toBe('light');
    expect(toggleTheme('light')).toBe('business');
  });
});
