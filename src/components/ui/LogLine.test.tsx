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
});
