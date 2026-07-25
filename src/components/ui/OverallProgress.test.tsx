import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { OverallProgress } from './OverallProgress';

describe('OverallProgress', () => {
  it('renders skeleton placeholder when value is 0 and no eta', () => {
    const { container } = render(() => <OverallProgress value={0} />);
    // Should render skeleton shimmer elements instead of the actual UI
    expect(
      container.querySelectorAll('.skeleton-shimmer').length,
    ).toBeGreaterThanOrEqual(3);
    // Should NOT show the batch-progress text yet
    expect(screen.queryByText('Batch progress')).toBeNull();
  });

  it('renders skeleton with correct aria label', () => {
    render(() => <OverallProgress value={0} />);
    expect(screen.getByLabelText('Batch progress loading')).toBeTruthy();
  });

  it('renders the progress percentage when value > 0', () => {
    render(() => <OverallProgress value={50} />);
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('renders the ETA when provided', () => {
    render(() => <OverallProgress value={30} eta="5m 0s left" />);
    expect(screen.getByText('5m 0s left')).toBeTruthy();
  });

  it('shows "Preparing..." when ETA is empty but value > 0', () => {
    render(() => <OverallProgress value={1} />);
    expect(screen.getByText('Preparing...')).toBeTruthy();
  });

  it('clamps value to 0 when negative (non-zero shows real UI)', () => {
    render(() => <OverallProgress value={-10} />);
    // -10 !== 0, so it renders the real UI with safeValue = 0
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('clamps value to 100 when above max', () => {
    render(() => <OverallProgress value={150} />);
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('handles NaN value gracefully (renders real UI clamped to 0)', () => {
    render(() => <OverallProgress value={NaN} />);
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('renders with progress element attributes for accessibility', () => {
    render(() => <OverallProgress value={75} />);
    const bar = screen.getByRole('progressbar');
    expect((bar as HTMLProgressElement).value).toBe(75);
    expect((bar as HTMLProgressElement).max).toBe(100);
  });
});
