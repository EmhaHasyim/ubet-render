import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { LogLine } from './LogLine';

function preForText(text: string): HTMLElement {
  return screen.getByText(text).closest('pre')!;
}

describe('LogLine — extended coverage', () => {
  it('applies text-error for bare FATAL: prefix', () => {
    render(() => <LogLine text="FATAL: out of memory" />);
    const pre = preForText('FATAL: out of memory');
    expect(pre.className).toContain('text-error');
  });

  it('applies text-error for bare ERROR: prefix', () => {
    render(() => <LogLine text="ERROR: disk full" />);
    const pre = preForText('ERROR: disk full');
    expect(pre.className).toContain('text-error');
  });

  it('does not colour non-fatal text containing the word fatal', () => {
    render(() => <LogLine text="non-fatal issue detected" />);
    const pre = preForText('non-fatal issue detected');
    expect(pre.className).not.toContain('text-error');
    expect(pre.className).not.toContain('text-warning');
  });

  it('renders SUCCESS level with green colour', () => {
    render(() => <LogLine text="[SUCCESS] Render complete" />);
    const pre = preForText('[SUCCESS] Render complete');
    expect(pre.className).toContain('text-success');
  });

  it('empty string renders without crash', () => {
    const { container } = render(() => <LogLine text="" />);
    const pre = container.querySelector('pre');
    expect(pre).toBeTruthy();
  });

  it('case-insensitive matching for bare FATAL/ERROR', () => {
    render(() => <LogLine text="fatal: crash" />);
    const pre = preForText('fatal: crash');
    expect(pre.className).toContain('text-error');

    // re-render with ERROR
    const { container } = render(() => <LogLine text="error: fail" />);
    expect(container.querySelector('pre')?.className).toContain('text-error');
  });

  it('no colour for text without any log prefix', () => {
    render(() => <LogLine text="Just a regular line of text here." />);
    const pre = screen
      .getByText('Just a regular line of text here.')
      .closest('pre')!;
    expect(pre.className.trim()).toBe('whitespace-pre-wrap break-words');
  });
});
