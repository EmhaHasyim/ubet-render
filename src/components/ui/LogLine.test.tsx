import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { LogLine } from './LogLine';

/** Helper: return the <pre> element that wraps a given text match. */
function preForText(text: string): HTMLElement {
  return screen.getByText(text).closest('pre')!;
}

describe('LogLine', () => {
  it('renders the log text', () => {
    render(() => <LogLine text="Hello world" />);
    expect(screen.getByText('Hello world')).toBeTruthy();
  });

  it('applies text-error class for [ERROR]', () => {
    render(() => <LogLine text="[ERROR] Something broke" />);
    const pre = preForText('[ERROR] Something broke');
    expect(pre.className).toContain('text-error');
  });

  it('applies text-error class for [FATAL]', () => {
    render(() => <LogLine text="[FATAL] crash" />);
    const pre = preForText('[FATAL] crash');
    expect(pre.className).toContain('text-error');
  });

  it('applies text-warning class for [WARN]', () => {
    render(() => <LogLine text="[WARN] Low disk space" />);
    const pre = preForText('[WARN] Low disk space');
    expect(pre.className).toContain('text-warning');
  });

  it('applies text-success class for [SUCCESS]', () => {
    render(() => <LogLine text="[SUCCESS] Render complete" />);
    const pre = preForText('[SUCCESS] Render complete');
    expect(pre.className).toContain('text-success');
  });

  it('applies text-info/80 class for [INFO]', () => {
    render(() => <LogLine text="[INFO] Starting render" />);
    const pre = preForText('[INFO] Starting render');
    expect(pre.className).toContain('text-info');
  });

  it('applies no color class for unknown level', () => {
    render(() => <LogLine text="[DEBUG] verbose" />);
    const pre = preForText('[DEBUG] verbose');
    expect(pre.className).not.toContain('text-error');
    expect(pre.className).not.toContain('text-warning');
    expect(pre.className).not.toContain('text-success');
    expect(pre.className).not.toContain('text-info');
  });

  it('renders inside a <pre> element', () => {
    render(() => <LogLine text="test" />);
    const el = screen.getByText('test');
    expect(el.closest('pre')).toBeTruthy();
  });

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
