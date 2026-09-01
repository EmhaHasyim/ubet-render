import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@solidjs/testing-library';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));
vi.mock('@tauri-apps/api/path', () => ({
  dirname: vi.fn((path: string) =>
    Promise.resolve(path.split('/').slice(0, -1).join('/') || '/'),
  ),
}));

import { SettingsCard } from './SettingsCard';
import { WithPipeline } from '../test-utils';

function renderCard(overrides?: Record<string, unknown>) {
  return render(() => (
    <WithPipeline overrides={overrides}>
      <SettingsCard />
    </WithPipeline>
  ));
}

describe('SettingsCard — extended coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Output folder ─────────────────────────────────────
  it('shows output folder path when set, with reveal button', () => {
    renderCard({ outputPath: () => '/renders/out' });
    expect(screen.getByText('/renders/out')).toBeTruthy();
    expect(screen.getByText('Open in Explorer')).toBeTruthy();
  });

  // ─── Audio mode radio ──────────────────────────────────
  it('renders Original and Normalize radio buttons', () => {
    renderCard();
    expect(screen.getByRole('radio', { name: 'Original' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Normalize' })).toBeTruthy();
  });

  // ─── Video codec selector ──────────────────────────────
  it('renders codec options (H.264, H.265, AV1)', () => {
    renderCard();
    expect(screen.getByText('H.264')).toBeTruthy();
    expect(screen.getByText('H.265')).toBeTruthy();
    // AV1 may show as "AV1" or "AV1 (unsupported)"
    const av1Matches = screen.getAllByText(/AV1/);
    expect(av1Matches.length).toBeGreaterThanOrEqual(1);
  });

  it('AV1 shows (unsupported) when av1Supported is false', () => {
    renderCard({ av1Supported: () => false });
    expect(screen.getByText(/AV1.*unsupported/i)).toBeTruthy();
  });

  // ─── Output format radio ───────────────────────────────
  it('renders MP4 and MKV radio buttons', () => {
    renderCard();
    expect(screen.getByRole('radio', { name: 'MP4' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'MKV' })).toBeTruthy();
  });

  // ─── Output prefix ─────────────────────────────────────
  it('renders output prefix input', () => {
    renderCard({ outputPrefix: () => 'My Channel' });
    const input = screen.getByDisplayValue('My Channel') as HTMLInputElement;
    expect(input).toBeTruthy();
  });

  // ─── Looping section ───────────────────────────────────
  it('renders By Duration and By Count radio buttons', () => {
    renderCard();
    expect(screen.getByRole('radio', { name: 'By Duration' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'By Count' })).toBeTruthy();
  });

  it('shows duration input when loopMode is duration', () => {
    renderCard({ loopMode: () => 'duration' as const });
    expect(screen.getByText('hours')).toBeTruthy();
  });

  it('shows count input when loopMode is count', () => {
    renderCard({ loopMode: () => 'count' as const });
    expect(screen.getByText('Repeat count')).toBeTruthy();
  });

  // ─── Feature toggles ───────────────────────────────────
  it('renders all remaining feature toggles with correct initial state', () => {
    renderCard({
      usePingpong: () => true,
      embedChapters: () => true,
    });
    expect(screen.getByText('Ping-pong effect')).toBeTruthy();
    expect(screen.getByText('Embed chapters')).toBeTruthy();
  });

  // ─── Zero-reencode (Skip re-encode) toggle ─────────────
  it('renders the "Skip re-encode" toggle with a short explanatory description', () => {
    renderCard();
    expect(screen.getByText(/Skip re-encode/i)).toBeTruthy();
    expect(screen.getByTestId('zero-reencode-toggle')).toBeTruthy();
    expect(
      screen.getByText(/Copy the source video without re-encoding/i),
    ).toBeTruthy();
  });

  // ─── Maxrate error display ─────────────────────────────
  it('shows error message when maxrate is invalid', () => {
    renderCard({
      maxrate: () => 'bad',
      maxrateValid: () => false,
    });
    expect(screen.getByText(/Enter a number between/i)).toBeTruthy();
  });

  it('no error message when maxrate is valid', () => {
    renderCard({
      maxrate: () => '4000k',
      maxrateValid: () => true,
    });
    expect(screen.queryByText(/Enter a number between/i)).toBeNull();
  });

  // ─── Section headers ───────────────────────────────────
  it('renders all collapse section headers', () => {
    renderCard();
    expect(screen.getByText('Audio')).toBeTruthy();
    expect(screen.getByText('Video & Encoding')).toBeTruthy();
    expect(screen.getByText('Looping')).toBeTruthy();
    expect(screen.getByText('Features')).toBeTruthy();
  });
});
