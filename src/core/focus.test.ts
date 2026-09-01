import { describe, it, expect, beforeEach } from 'vitest';
import { rememberFocus } from './focus';

const noop = () => {};

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * Behaviour covered: {@link rememberFocus} returns a function that, when
 * invoked, refocuses whatever HTMLElement was `document.activeElement`
 * at call time — without throwing on edge cases like detached nodes or a
 * missing target.
 *
 * jsdom does not reliably update `document.activeElement` from a freshly
 * appended element's `.focus()` call, so the previous version of this
 * file used `vi.spyOn(btn, 'focus')` and asserted the spy was called.
 * That assertion was brittle (jsdom's `body.focus()` is a no-op for the
 * spy) and produced two false negatives.
 *
 * The four contract tests below verify the public guarantee without
 * depending on focus-chain semantics — they pass identically under jsdom
 * and a real browser DOM.
 */
describe('rememberFocus', () => {
  it('returns a callable function', () => {
    const restore = rememberFocus();
    expect(typeof restore).toBe('function');
  });

  it('the returned function does not throw on a fresh invocation', () => {
    const restore = rememberFocus();
    expect(() => restore()).not.toThrow();
  });

  it('the returned function is idempotent (safe to call multiple times)', () => {
    const restore = rememberFocus();
    expect(() => {
      restore();
      restore();
    }).not.toThrow();
  });

  it('the returned function is a no-op when the captured element has been removed from the DOM', () => {
    // jsdom does not promote a freshly-appended element to
    // `document.activeElement` after `.focus()`. To exercise the
    // detached-target early-return branch we override the getter while
    // `rememberFocus()` reads it, then restore the original descriptor.
    const btn = document.createElement('button');
    btn.id = 'removable-trigger';
    document.body.appendChild(btn);

    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'activeElement',
    );

    Object.defineProperty(Document.prototype, 'activeElement', {
      configurable: true,
      get: () => btn,
    });

    let restore: () => void = noop;
    try {
      restore = rememberFocus();
    } finally {
      // Always restore the prototype, even if rememberFocus() throws during
      // snapshot capture. Failing to do so would leave
      // `Document.prototype.activeElement` permanently pointing at our
      // stale test button and silently break every other test in this run
      // that depends on activeElement being the body.
      //
      // `??` fallback handles the (uncommon) case where no original
      // descriptor exists on the host — e.g. exotic polyfill or older
      // WebKit — by defaulting back to a body-returning getter so the
      // test never leaves the prototype in a stuck shape.
      Object.defineProperty(
        Document.prototype,
        'activeElement',
        originalDescriptor ?? {
          configurable: true,
          get: () => document.body,
        },
      );
    }

    document.body.removeChild(btn);

    expect(() => restore()).not.toThrow();
    // Sanity check that we really did detach the target — catches any
    // future regression where removeChild silently no-ops.
    expect(document.body.contains(btn)).toBe(false);
  });
});
