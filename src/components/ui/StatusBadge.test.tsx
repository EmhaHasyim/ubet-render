import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('renders "Pending" for pending state', () => {
    render(() => <StatusBadge state="pending" />);
    expect(screen.getByText('Pending')).toBeTruthy();
  });

  it('renders "Processing" for processing state', () => {
    render(() => <StatusBadge state="processing" />);
    expect(screen.getByText('Processing')).toBeTruthy();
  });

  it('renders "Done" for done state', () => {
    render(() => <StatusBadge state="done" />);
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it('renders "Error" for error state', () => {
    render(() => <StatusBadge state="error" />);
    expect(screen.getByText('Error')).toBeTruthy();
  });

  it('apples the badge class to the element', () => {
    render(() => <StatusBadge state="done" />);
    const badge = screen.getByText('Done');
    expect(badge.className).toContain('badge');
  });
});
