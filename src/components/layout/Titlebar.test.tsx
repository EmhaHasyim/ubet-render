import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@solidjs/testing-library';

const mockMinimize = vi.fn();
const mockHide = vi.fn();
const mockToggleMaximize = vi.fn();
const mockIsMaximized = vi.fn(() => Promise.resolve(false));
const mockOnResized = vi.fn(() => Promise.resolve(() => {}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    isMaximized: mockIsMaximized,
    minimize: mockMinimize,
    hide: mockHide,
    toggleMaximize: mockToggleMaximize,
    onResized: mockOnResized,
  })),
}));

import { Titlebar } from './Titlebar';

describe('Titlebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMaximized.mockResolvedValue(false);
  });

  it('renders the titlebar with app name', () => {
    render(() => <Titlebar />);
    expect(screen.getByText('Ubet Render')).toBeTruthy();
  });

  it('renders minimize button', () => {
    render(() => <Titlebar />);
    expect(screen.getByLabelText('Minimize')).toBeTruthy();
  });

  it('renders maximize button (not maximized)', () => {
    render(() => <Titlebar />);
    expect(screen.getByLabelText('Maximize')).toBeTruthy();
  });

  it('renders close button', () => {
    render(() => <Titlebar />);
    expect(screen.getByLabelText('Close to tray')).toBeTruthy();
  });

  it('calls minimize on minimize button click', async () => {
    render(() => <Titlebar />);
    screen.getByLabelText('Minimize').click();
    // SolidJS async onMount hasn't resolved yet, but click handler is sync
    expect(mockMinimize).toHaveBeenCalled();
  });

  it('calls toggleMaximize on maximize button click', async () => {
    render(() => <Titlebar />);
    screen.getByLabelText('Maximize').click();
    expect(mockToggleMaximize).toHaveBeenCalled();
  });

  it('calls hide on close button click', async () => {
    render(() => <Titlebar />);
    screen.getByLabelText('Close to tray').click();
    expect(mockHide).toHaveBeenCalled();
  });

  it('shows context menu items on right click', () => {
    const { container } = render(() => <Titlebar />);
    const dragRegion = container.querySelector(
      '[data-tauri-drag-region]',
    ) as HTMLElement;
    expect(dragRegion).toBeTruthy();

    dragRegion.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));

    expect(screen.getByText('Minimize')).toBeTruthy();
    expect(screen.getByText('Hide to tray')).toBeTruthy();
  });

  it('shows Restore label when maximized on mount', async () => {
    mockIsMaximized.mockResolvedValue(true);
    render(() => <Titlebar />);

    await vi.waitFor(() => {
      expect(screen.getByLabelText('Restore')).toBeTruthy();
    });
  });
});
