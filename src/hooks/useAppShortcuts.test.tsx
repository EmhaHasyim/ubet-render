import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { type Setter } from 'solid-js';
import { useAppShortcuts, type AppTabId } from './useAppShortcuts';

const { mockWindow } = vi.hoisted(() => ({
  mockWindow: {
    isFullscreen: vi.fn(() => Promise.resolve(false)),
    setFullscreen: vi.fn(() => Promise.resolve()),
    hide: vi.fn(() => Promise.resolve()),
    minimize: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => mockWindow),
}));

function mountShortcuts() {
  const setActiveTab = vi.fn() as unknown as Setter<AppTabId>;
  let shortcuts!: ReturnType<typeof useAppShortcuts>;

  const rendered = render(() => {
    shortcuts = useAppShortcuts(setActiveTab);
    return <div />;
  });

  return { ...rendered, shortcuts, setActiveTab };
}

describe('useAppShortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWindow.isFullscreen.mockResolvedValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  it('toggles the Tauri window fullscreen state with F11', async () => {
    mountShortcuts();
    await Promise.resolve();

    fireEvent.keyDown(window, { key: 'F11' });
    fireEvent.keyDown(window, { key: 'F11' });

    expect(mockWindow.setFullscreen).toHaveBeenNthCalledWith(1, true);
    expect(mockWindow.setFullscreen).toHaveBeenNthCalledWith(2, false);
  });

  it('hides the window with Ctrl/Cmd+W', () => {
    mountShortcuts();
    const event = new KeyboardEvent('keydown', {
      key: 'w',
      metaKey: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(mockWindow.hide).toHaveBeenCalledOnce();
  });

  it('minimizes the window with Ctrl/Cmd+Shift+M', () => {
    mountShortcuts();
    const event = new KeyboardEvent('keydown', {
      key: 'M',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(mockWindow.minimize).toHaveBeenCalledOnce();
  });

  it('removes the registered global listener when the owner unmounts', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const removeEventListener = vi.spyOn(window, 'removeEventListener');

    try {
      const { unmount, setActiveTab } = mountShortcuts();
      const keydownListener = addEventListener.mock.calls.find(
        ([eventName]) => eventName === 'keydown',
      )?.[1];

      expect(keydownListener).toEqual(expect.any(Function));

      unmount();
      fireEvent.keyDown(window, { key: '2', ctrlKey: true });

      expect(removeEventListener).toHaveBeenCalledWith(
        'keydown',
        keydownListener,
      );
      expect(setActiveTab).not.toHaveBeenCalled();
    } finally {
      addEventListener.mockRestore();
      removeEventListener.mockRestore();
    }
  });
});
