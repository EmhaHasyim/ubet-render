import { describe, it, expect, vi } from 'vitest';

describe('index.tsx entry point', () => {
  it('throws when #root element is missing', async () => {
    const oldRoot = document.getElementById('root');
    if (oldRoot) oldRoot.remove();

    await expect(async () => {
      await import('./index');
    }).rejects.toThrow('Root element #root not found in the DOM.');
  }, 15_000);

  it('calls render when #root is present', async () => {
    vi.resetModules();

    let rootEl = document.getElementById('root');
    if (!rootEl) {
      rootEl = document.createElement('div');
      rootEl.id = 'root';
      document.body.appendChild(rootEl);
    }

    const mockRender = vi.fn();

    vi.doMock('solid-js/web', () => ({
      render: mockRender,
      template: vi.fn(),
      createComponent: vi.fn(),
      delegateEvents: vi.fn(),
      insert: vi.fn(),
      spread: vi.fn(),
      setProp: vi.fn(),
      className: vi.fn(),
      mergeProps: vi.fn(),
    }));

    // App mock: return a valid SolidJS component shape
    vi.doMock('./App', () => ({
      default: () =>
        ({}) as unknown as ReturnType<
          typeof import('solid-js').createComponent
        >,
    }));

    await import('./index');

    expect(mockRender).toHaveBeenCalled();
  });
});
