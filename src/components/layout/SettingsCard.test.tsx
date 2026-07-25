import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

import type { Pipeline } from '../../context/pipeline';
import { SettingsCard } from './SettingsCard';
import { WithPipeline } from '../test-utils';

function renderCard(overrides?: Record<string, unknown>) {
  return render(() => (
    <WithPipeline overrides={overrides as unknown as Partial<Pipeline>}>
      <SettingsCard />
    </WithPipeline>
  ));
}

describe('SettingsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the section heading', () => {
    renderCard();
    expect(screen.getByText('Sources and output')).toBeTruthy();
  });

  it('renders SourceSelector for Master video', () => {
    renderCard();
    expect(screen.getByText('Master video')).toBeTruthy();
  });

  it('renders SourceSelector for Audio tracks', () => {
    renderCard();
    expect(screen.getByText('Audio tracks')).toBeTruthy();
  });

  it('renders Output folder button', () => {
    renderCard();
    expect(screen.getByText('Output folder')).toBeTruthy();
  });

  it('shows "Choose folder" when no output path set', () => {
    renderCard();
    expect(screen.getByText('Choose folder')).toBeTruthy();
  });

  it('shows "No folder selected" fallback when no output path', () => {
    renderCard();
    expect(screen.getByText('No folder selected.')).toBeTruthy();
  });

  it('shows destination selected when output path is set', () => {
    renderCard({ outputPath: () => '/out/render' });
    expect(screen.getByText('Destination selected')).toBeTruthy();
  });

  it('shows selected folder path when output path is set', () => {
    renderCard({ outputPath: () => '/out/render' });
    expect(screen.getByText('/out/render')).toBeTruthy();
  });

  it('renders render options heading', () => {
    renderCard();
    expect(screen.getByText('Render options')).toBeTruthy();
  });

  it('renders codec selector', () => {
    renderCard();
    expect(screen.getByText('Video codec')).toBeTruthy();
    expect(screen.getByText('H.264')).toBeTruthy();
    expect(screen.getByText('H.265')).toBeTruthy();
  });

  it('disables AV1 option when av1Supported is false', () => {
    renderCard({ av1Supported: () => false });
    // The select value is codec='av1' (default), so the option with value='av1'
    // is selected and its text is 'AV1 (unsupported)'.
    const opt = screen.getByText('AV1 (unsupported)') as HTMLOptionElement;
    expect(opt.disabled).toBe(true);
  });

  it('enables AV1 option when av1Supported is true', () => {
    const { container } = renderCard({ av1Supported: () => true });
    const av1Option = container.querySelector(
      'select option[value="av1"]',
    ) as HTMLOptionElement;
    expect(av1Option).toBeTruthy();
    expect(av1Option.disabled).toBe(false);
  });

  it('shows maxrate input with default value', () => {
    renderCard();
    const input = screen.getByDisplayValue('4000k') as HTMLInputElement;
    expect(input).toBeTruthy();
  });

  it('shows maxrate error when invalid', () => {
    renderCard({ maxrate: () => 'invalid', maxrateValid: () => false });
    expect(screen.getByText(/Enter a number between/i)).toBeTruthy();
  });

  it('shows bitrate input with error class when invalid', () => {
    renderCard({ maxrate: () => 'bad', maxrateValid: () => false });
    const input = screen.getByDisplayValue('bad') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('renders output format radio buttons', () => {
    renderCard();
    expect(screen.getByRole('radio', { name: 'MP4' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'MKV' })).toBeTruthy();
  });

  it('renders looping section', () => {
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

  it('renders features section with toggles', () => {
    renderCard();
    expect(screen.getByText('Ping-pong effect')).toBeTruthy();
    expect(screen.getByText('Embed chapters')).toBeTruthy();
  });

  it('renders the "Skip re-encode (zero-reencode / stream copy)" toggle', () => {
    renderCard();
    expect(
      screen.getByText(/Skip re-encode \(zero-reencode \/ stream copy\)/i),
    ).toBeTruthy();
    expect(screen.getByTestId('zero-reencode-toggle')).toBeTruthy();
  });

  it('zero-reencode toggle reflects checked state from pipeline config', () => {
    const { container } = renderCard({
      skipIntermediateOnCodecMatch: () => false,
    });
    const toggle = container.querySelector(
      '[data-testid="zero-reencode-toggle"] input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(false);
  });

  it('zero-reencode toggle is checked when pipeline config says true', () => {
    const { container } = renderCard({
      skipIntermediateOnCodecMatch: () => true,
    });
    const toggle = container.querySelector(
      '[data-testid="zero-reencode-toggle"] input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(true);
  });

  it('clicking the zero-reencode toggle calls setSkipIntermediateOnCodecMatch with new value', () => {
    const setSkip = vi.fn();
    const { container } = renderCard({
      skipIntermediateOnCodecMatch: () => true,
      setSkipIntermediateOnCodecMatch: setSkip,
    });
    const toggle = container.querySelector(
      '[data-testid="zero-reencode-toggle"] input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(true);
    // fireEvent.click toggles the checkbox's DOM state (true → false) and
    // dispatches the 'change' event Solid's onChange handler listens to. The
    // handler reads the live DOM `checked` value, so we side-step the
    // currentTarget-override quirks of `fireEvent.change`.
    fireEvent.click(toggle);
    expect(setSkip).toHaveBeenCalledWith(false);
  });
});
