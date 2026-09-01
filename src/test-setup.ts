/**
 * Test setup — runs before every test file.
 *
 * jsdom (via vitest) should provide `localStorage` natively, but in some
 * version combinations (vitest 4.x + jsdom 29.x) it may be missing.
 * This polyfill ensures it's always available so tests of persistence
 * helpers and components that read/write localStorage work reliably.
 */
if (
  typeof globalThis.localStorage === 'undefined' ||
  !globalThis.localStorage
) {
  const store = new Map<string, string>();

  const mockStorage: Storage = {
    getItem(key: string): string | null {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    get length(): number {
      return store.size;
    },
    key(index: number): string | null {
      const keys = [...store.keys()];
      return keys[index] ?? null;
    },
  };

  Object.defineProperty(globalThis, 'localStorage', {
    value: mockStorage,
    writable: true,
    configurable: true,
  });
}

/**
 * Polyfill `<dialog>.showModal()` / `.close()` for jsdom, which does not
 * implement the HTMLDialogElement API.  We patch `HTMLElement.prototype`
 * (always available) rather than `HTMLDialogElement` (undefined in jsdom).
 */
if (!('showModal' in HTMLElement.prototype)) {
  (HTMLElement.prototype as unknown as Record<string, unknown>).showModal =
    function (this: HTMLElement) {
      this.setAttribute('open', '');
    };

  (HTMLElement.prototype as unknown as Record<string, unknown>).close =
    function (this: HTMLElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
}

/**
 * Polyfill `ResizeObserver` for jsdom, which does not implement it.
 * The virtual scroller in LogViewer uses ResizeObserver to track the
 * viewport height of the scrollable container.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverMock implements ResizeObserver {
    private callback: ResizeObserverCallback;
    private observedElements: Set<Element> = new Set();

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element): void {
      this.observedElements.add(target);
      // Fire immediately with a sensible default entry so consumers
      // that depend on initial measurements (e.g. virtual scroll viewport
      // height) have data to work with on the first frame.
      queueMicrotask(() => {
        if (!this.observedElements.has(target)) return;
        const entry: ResizeObserverEntry = {
          target,
          contentRect: target.getBoundingClientRect(),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        };
        this.callback([entry], this);
      });
    }

    unobserve(target: Element): void {
      this.observedElements.delete(target);
    }

    disconnect(): void {
      this.observedElements.clear();
    }
  }

  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: ResizeObserverMock,
    writable: true,
    configurable: true,
  });
}
