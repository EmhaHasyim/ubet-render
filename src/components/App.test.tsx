/**
 * Tests untuk App.tsx — Dashboard rendering, ErrorBoundary, tab switching.
 * Menggunakan mock Tauri API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@solidjs/testing-library';

// ---------------------------------------------------------------------------
// Mocks — must be at top level
// ---------------------------------------------------------------------------
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
    isMaximized: vi.fn(() => Promise.resolve(false)),
    isFullscreen: vi.fn(() => Promise.resolve(false)),
    setFullscreen: vi.fn(),
    hide: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    onResized: vi.fn(() => Promise.resolve(() => {})),
    setProgressBar: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    onCloseRequested: vi.fn(() => Promise.resolve(() => {})),
  })),
  // Tauri 2 ProgressBarStatus enum (mirrors @tauri-apps/api/window).
  // Required by `App.tsx`'s v0.2.3 import for the taskbar progress indicator.
  // Without this the module-resolution fails and rendering falls through
  // to the ErrorBoundary's <FatalScreen>.
  ProgressBarStatus: {
    None: 'none',
    Normal: 'normal',
    Indeterminate: 'indeterminate',
    Paused: 'paused',
    Error: 'error',
  },
}));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(() => Promise.resolve(true)),
  requestPermission: vi.fn(() => Promise.resolve('granted')),
  sendNotification: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('@tauri-apps/api/path', () => ({
  dirname: vi.fn((path: string) =>
    Promise.resolve(path.split('/').slice(0, -1).join('/') || '/'),
  ),
}));

import App from '../App';

describe('App', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the app shell without crashing', () => {
    const { container } = render(() => <App />);
    expect(container).toBeTruthy();
  });

  it('shows Ubet Render title', () => {
    render(() => <App />);
    // Use getAllByText because multiple elements have the text
    const matches = screen.getAllByText('Ubet Render');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('shows Render tab button', () => {
    render(() => <App />);
    expect(screen.getByText('Render')).toBeTruthy();
  });

  it('shows Activity tab button', () => {
    render(() => <App />);
    expect(screen.getByText('Activity')).toBeTruthy();
  });

  it('shows Settings area on Render tab', () => {
    render(() => <App />);
    expect(screen.getByText('Render setup')).toBeTruthy();
    expect(
      screen.getByText('Sources, audio, output, and encoding.'),
    ).toBeTruthy();
  });

  it('shows Hardware panel', () => {
    render(() => <App />);
    expect(screen.getByText('Hardware')).toBeTruthy();
  });

  it('shows Idle badge in header', () => {
    render(() => <App />);
    const badges = screen.getAllByText('Idle');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it('switches to Activity tab when clicking Activity', () => {
    render(() => <App />);
    const activityTab = screen.getByText('Activity');
    activityTab.click();

    expect(screen.getByText('Jobs and logs.')).toBeTruthy();
    expect(screen.getByText('Jobs')).toBeTruthy();
    expect(screen.getByText('Logs')).toBeTruthy();
  });

  it('switches back to Render tab', () => {
    render(() => <App />);
    // Go to Activity
    screen.getByText('Activity').click();
    expect(screen.getByText('Back to setup')).toBeTruthy();

    // Go back
    screen.getByText('Back to setup').click();
    expect(screen.getByText('Render setup')).toBeTruthy();
  });

  it('switches to Activity with the Ctrl+2 global shortcut', () => {
    render(() => <App />);

    fireEvent.keyDown(window, { key: '2', ctrlKey: true });

    expect(screen.getByText('Jobs and logs.')).toBeTruthy();
  });

  it('opens the shortcuts dialog with the F1 global shortcut', async () => {
    render(() => <App />);

    fireEvent.keyDown(window, { key: 'F1' });
    await Promise.resolve();

    expect(
      screen.getByRole('dialog', { name: /Keyboard shortcuts/i }),
    ).toBeTruthy();
  });
});
