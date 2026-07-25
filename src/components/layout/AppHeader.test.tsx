import { render, screen } from '@solidjs/testing-library';
import { describe, it, expect, vi } from 'vitest';
import { AppHeader } from './AppHeader';

function renderHeader(overrides?: Partial<Parameters<typeof AppHeader>[0]>) {
  const props = {
    running: false,
    paused: false,
    onStart: vi.fn(),
    onResume: vi.fn(),
    onCancel: vi.fn(),
    onPause: vi.fn(),
    canStart: false,
    ...overrides,
  };
  return { ...render(() => <AppHeader {...props} />), props };
}

describe('AppHeader', () => {
  it('shows Ready state when idle', () => {
    renderHeader();
    expect(screen.getByText('Ready')).toBeTruthy();
  });

  it('shows Rendering batch when running', () => {
    renderHeader({ running: true });
    expect(screen.getByText('Rendering batch')).toBeTruthy();
  });

  it('shows Render paused when paused', () => {
    renderHeader({ paused: true });
    expect(screen.getByText('Render paused')).toBeTruthy();
  });

  it('shows missing paths hint when idle and canStart is false', () => {
    renderHeader();
    expect(screen.getByText('Missing paths.')).toBeTruthy();
  });

  it('shows all paths set hint when idle and canStart is true', () => {
    renderHeader({ canStart: true });
    expect(screen.getByText('All paths set.')).toBeTruthy();
  });

  it('renders Start new batch button when idle', () => {
    renderHeader();
    expect(screen.getByText('Start new batch')).toBeTruthy();
  });

  it('Start button is disabled when canStart is false', () => {
    renderHeader();
    const btn = screen.getByText('Start new batch') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Start button is enabled when canStart is true', () => {
    renderHeader({ canStart: true });
    const btn = screen.getByText('Start new batch') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('calls onStart(false) when Start button clicked', () => {
    const { props } = renderHeader({ canStart: true });
    screen.getByText('Start new batch').click();
    expect(props.onStart).toHaveBeenCalledWith(false);
  });

  it('shows Resume render button when paused', () => {
    renderHeader({ paused: true });
    expect(screen.getByText('Resume render')).toBeTruthy();
  });

  it('calls onResume when Resume button clicked', () => {
    const { props } = renderHeader({ paused: true });
    screen.getByText('Resume render').click();
    expect(props.onResume).toHaveBeenCalled();
  });

  it('shows Pause and Cancel buttons when running', () => {
    renderHeader({ running: true });
    expect(screen.getByText('Pause render')).toBeTruthy();
    expect(screen.getByText('Cancel render')).toBeTruthy();
  });

  it('calls onPause when Pause button clicked', () => {
    const { props } = renderHeader({ running: true });
    screen.getByText('Pause render').click();
    expect(props.onPause).toHaveBeenCalled();
  });

  it('opens cancel dialog when Cancel button clicked', () => {
    renderHeader({ running: true });
    screen.getByText('Cancel render').click();
    expect(screen.getByText('Cancel render?')).toBeTruthy();
    expect(screen.getByText(/FFmpeg process/i)).toBeTruthy();
  });

  it('calls onCancel and closes dialog when confirm Cancel clicked', () => {
    const { props } = renderHeader({ running: true });
    screen.getByText('Cancel render').click();
    expect(screen.getByText('Cancel render?')).toBeTruthy(); // dialog visible

    // Two buttons match /cancel render/i: the trigger and the confirmation.
    // Pick the last one (the confirmation button inside the dialog).
    const confirmBtns = screen.getAllByRole('button', {
      name: /cancel render/i,
    });
    const confirmBtn = confirmBtns[confirmBtns.length - 1];
    confirmBtn.click();

    expect(props.onCancel).toHaveBeenCalled();
  });
});
