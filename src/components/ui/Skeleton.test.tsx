import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  it('renders default text variant', () => {
    const { container } = render(() => <Skeleton class="h-4 w-48" />);
    const el = container.querySelector('.skeleton-shimmer')!;
    expect(el).toBeTruthy();
    expect(el.className).toContain('rounded-md');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders circle variant', () => {
    const { container } = render(() => (
      <Skeleton variant="circle" class="h-10 w-10" />
    ));
    const el = container.querySelector('.skeleton-shimmer')!;
    expect(el.className).toContain('rounded-full');
  });

  it('renders rect variant', () => {
    const { container } = render(() => (
      <Skeleton variant="rect" class="h-24 w-full" />
    ));
    const el = container.querySelector('.skeleton-shimmer')!;
    expect(el.className).toContain('rounded-lg');
  });

  it('sets aria-hidden=true when no label', () => {
    const { container } = render(() => <Skeleton />);
    const el = container.querySelector('.skeleton-shimmer')!;
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('sets role=status and aria-label when label provided', () => {
    render(() => <Skeleton label="Loading hardware info..." />);
    const el = screen.getByRole('status');
    expect(el).toBeTruthy();
    expect(el.getAttribute('aria-label')).toBe('Loading hardware info...');
  });

  it('applies custom class alongside variant class', () => {
    const { container } = render(() => (
      <Skeleton variant="text" class="my-custom" />
    ));
    const el = container.querySelector('.skeleton-shimmer')!;
    expect(el.className).toContain('my-custom');
    expect(el.className).toContain('rounded-md');
  });
});
