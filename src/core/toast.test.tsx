import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { ToastViewport } from '../components/ui/Toast';
import { dismissToast, showToast, useToasts } from './toast';

beforeEach(() => {
  // Clear any toasts left over from prior tests — module-scope signals persist.
  const cur = useToasts()();
  for (const t of cur) dismissToast(t.id);
  vi.useRealTimers();
});

describe('toast store API', () => {
  it('adds a toast to the queue', () => {
    render(() => <ToastViewport />);
    showToast('Saved', { variant: 'success' });
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('uses the supplied variant for icon and alert class', () => {
    render(() => <ToastViewport />);
    showToast('Failure', { variant: 'error', ttl: 0 });
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('alert-error');
  });

  it('status (non-warning/error) alerts use role="status"', () => {
    render(() => <ToastViewport />);
    showToast('Info', { variant: 'info', ttl: 0 });
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('dismissToast removes a toast from the queue', () => {
    render(() => <ToastViewport />);
    const id = showToast('Dismiss me', { ttl: 0 });
    expect(screen.getByText('Dismiss me')).toBeTruthy();
    dismissToast(id);
    expect(screen.queryByText('Dismiss me')).toBeNull();
  });

  it('exposes a manual dismiss button inside the toast', () => {
    render(() => <ToastViewport />);
    showToast('Tap to close', { ttl: 0 });
    screen.getByLabelText('Dismiss notification').click();
    expect(screen.queryByText('Tap to close')).toBeNull();
  });

  it('enqueues ids monotonically across calls', () => {
    render(() => <ToastViewport />);
    const a = showToast('A', { ttl: 0 });
    const b = showToast('B', { ttl: 0 });
    const c = showToast('C', { ttl: 0 });
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});

describe('toast auto-dismiss timing', () => {
  it('auto-removes a toast after its ttl elapses', async () => {
    vi.useFakeTimers();
    render(() => <ToastViewport />);
    showToast('Timed', { ttl: 200 });

    expect(screen.getByText('Timed')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(250);
    expect(screen.queryByText('Timed')).toBeNull();
  });

  it('respects ttl: 0 (sticky)', () => {
    vi.useFakeTimers();
    render(() => <ToastViewport />);
    showToast('Sticky', { ttl: 0 });
    expect(screen.getByText('Sticky')).toBeTruthy();
    vi.advanceTimersByTime(60_000);
    expect(screen.getByText('Sticky')).toBeTruthy();
  });

  it('uses 3500ms as the default ttl', async () => {
    vi.useFakeTimers();
    render(() => <ToastViewport />);
    showToast('Default');
    expect(screen.getByText('Default')).toBeTruthy();

    await vi.advanceTimersByTimeAsync(3500);
    expect(screen.queryByText('Default')).toBeNull();
  });
});
