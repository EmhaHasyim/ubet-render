import { render, screen } from '@solidjs/testing-library';
import { describe, it, expect, vi } from 'vitest';
import { FatalScreen } from './FatalScreen';

describe('FatalScreen', () => {
  it('renders the error message from Error instance', () => {
    const reset = vi.fn();
    render(() => <FatalScreen error={new Error('Disk full')} reset={reset} />);
    expect(screen.getByText('Disk full')).toBeTruthy();
  });

  it('renders fallback message when error is an empty object', () => {
    const reset = vi.fn();
    render(() => <FatalScreen error={{}} reset={reset} />);
    expect(screen.getByText('An unexpected error occurred.')).toBeTruthy();
  });

  it('renders fallback message when error is null', () => {
    const reset = vi.fn();
    render(() => <FatalScreen error={null} reset={reset} />);
    expect(screen.getByText('An unexpected error occurred.')).toBeTruthy();
  });

  it('renders error string directly', () => {
    const reset = vi.fn();
    render(() => <FatalScreen error="Connection refused" reset={reset} />);
    expect(screen.getByText('Connection refused')).toBeTruthy();
  });

  it('calls reset when the Reload button is clicked', () => {
    const reset = vi.fn();
    render(() => <FatalScreen error={new Error('Oops')} reset={reset} />);
    const btn = screen.getByRole('button', { name: /reload/i });
    btn.click();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('shows the Something went wrong heading', () => {
    const reset = vi.fn();
    render(() => <FatalScreen error={new Error('X')} reset={reset} />);
    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });
});
