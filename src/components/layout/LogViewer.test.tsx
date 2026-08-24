import { render, screen } from '@solidjs/testing-library';
import { describe, it, expect } from 'vitest';
import { LogViewer } from './LogViewer';

describe('LogViewer', () => {
  it('shows empty state when logs array is empty', () => {
    render(() => <LogViewer logs={[]} />);
    expect(
      screen.getByText('Logs will appear here when you start a render.'),
    ).toBeTruthy();
  });

  it('renders log lines', () => {
    render(() => <LogViewer logs={['[INFO] Starting', '[DONE] Finished']} />);
    expect(screen.getByText('[INFO] Starting')).toBeTruthy();
    expect(screen.getByText('[DONE] Finished')).toBeTruthy();
  });

  it('renders multiple log lines in correct order', () => {
    const logs = ['Line 1', 'Line 2', 'Line 3'];
    render(() => <LogViewer logs={logs} />);
    const elements = logs.map((l) => screen.getByText(l));
    expect(elements).toHaveLength(3);
  });

  it('shows the log count badge', () => {
    render(() => <LogViewer logs={['A', 'B', 'C']} />);
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('renders heading', () => {
    render(() => <LogViewer logs={[]} />);
    expect(screen.getByText('Logs')).toBeTruthy();
  });
});
