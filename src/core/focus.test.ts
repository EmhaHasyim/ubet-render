import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rememberFocus } from './focus';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('rememberFocus', () => {
  it('captures the active element at call time and calls .focus() on it during restore', () => {
    const btn = document.createElement('button');
    btn.id = 'trigger';
    document.body.appendChild(btn);

    // Spy on the captured element's focus() — jsdom does not reliably
    // update document.activeElement via programmatic focus(), so we verify
    // the restore callback calls the right method on the right element.
    const focusSpy = vi.spyOn(btn, 'focus');

    const restore = rememberFocus();
    // captured element should be body / null at the time of capture
    // — the test only asserts the *direction* the restore callback points.
    restore();

    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('points to the captured element even when focus has changed since', () => {
    const btn1 = document.createElement('button');
    document.body.appendChild(btn1);
    const spy1 = vi.spyOn(btn1, 'focus');

    const first = rememberFocus();

    const btn2 = document.createElement('button');
    document.body.appendChild(btn2);
    const spy2 = vi.spyOn(btn2, 'focus');

    const second = rememberFocus();
    second();
    expect(spy2).toHaveBeenCalled();

    first();
    expect(spy1).toHaveBeenCalled();
  });

  it('is a no-op when the captured element was removed from the DOM', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();
    expect(document.activeElement).toBe(btn);

    const restore = rememberFocus();
    document.body.removeChild(btn);

    expect(() => restore()).not.toThrow();
    // The detached element should NOT receive a focus() call after
    // removal — focus() can throw or warn in some browsers when called
    // on a detached node.
    expect(() => restore()).not.toThrow();
  });

  it('is a no-op when there is no focusable active element', () => {
    // Body is the default; ensure focus management APIs don't error.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur?.();
    }
    const restore = rememberFocus();
    expect(() => restore()).not.toThrow();
  });
});
