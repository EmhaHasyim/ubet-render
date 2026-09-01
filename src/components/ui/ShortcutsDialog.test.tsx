import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { ShortcutsDialog } from './ShortcutsDialog';

/**
 * Stub @iconify-icon/solid so the test suite doesn't depend on the
 * iconify runtime (network SVG fetching + jsdom-SVG quirks). Every
 * assertion below targets text content, button roles, or DOM
 * attributes, so a no-op Icon stub is sufficient.
 */
vi.mock('@iconify-icon/solid', () => ({
  Icon: () => null,
}));

function ShortcutsDialogTestWrapper() {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <button
        type="button"
        data-testid="open-dialog"
        onClick={() => setOpen(true)}
      >
        open
      </button>
      <ShortcutsDialog isOpen={open()} onClose={() => setOpen(false)} />
    </>
  );
}

describe('ShortcutsDialog', () => {
  it('renders nothing when isOpen is false (Show unmounts the dialog)', () => {
    const { container } = render(() => (
      <ShortcutsDialog isOpen={false} onClose={() => {}} />
    ));
    expect(container.querySelector('dialog')).toBeNull();
  });

  it('renders the dialog with title when isOpen flips true', async () => {
    // Wrapper so isOpen can flip synchronously; await lets the createEffect
    // that calls dialogRef.showModal() commit before we assert the 'open'
    // attribute.
    render(() => <ShortcutsDialogTestWrapper />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByTestId('open-dialog'));
    await Promise.resolve();

    const dialog = screen.getByRole('dialog', { name: /Keyboard shortcuts/i });
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(screen.getByText('Toggle fullscreen')).toBeTruthy();
  });

  it('renders every shortcut row from SHORTCUTS', () => {
    render(() => <ShortcutsDialog isOpen={true} onClose={() => {}} />);
    // Don't tie the test to the constant; check labels that the App.tsx
    // keydown handler promises to honour.
    expect(screen.getByText('Toggle fullscreen')).toBeTruthy();
    expect(screen.getByText('Hide window to tray')).toBeTruthy();
    expect(screen.getByText('Minimize window')).toBeTruthy();
    expect(screen.getByText('Open Render tab')).toBeTruthy();
    expect(screen.getByText('Open Activity tab')).toBeTruthy();
    expect(screen.getByText('Show this help dialog')).toBeTruthy();
    expect(screen.getByText('Close dialogs and menus')).toBeTruthy();
  });

  it('renders shortcut keys as <kbd> elements', () => {
    render(() => <ShortcutsDialog isOpen={true} onClose={() => {}} />);
    expect(document.querySelectorAll('kbd').length).toBeGreaterThan(0);
  });

  it('groups shortcuts under Window / Render / General headings', () => {
    render(() => <ShortcutsDialog isOpen={true} onClose={() => {}} />);
    const headings = Array.from(document.querySelectorAll('h3')).map(
      (h) => h.textContent?.trim() ?? '',
    );
    expect(headings).toContain('Window');
    expect(headings).toContain('Render');
    expect(headings).toContain('General');
  });

  it('closes via the X button (aria-label = "Close shortcuts dialog")', () => {
    const onClose = vi.fn();
    render(() => <ShortcutsDialog isOpen={true} onClose={onClose} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Close shortcuts dialog' }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via the footer "Close" button (data-testid = "shortcuts-close")', () => {
    const onClose = vi.fn();
    render(() => <ShortcutsDialog isOpen={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('shortcuts-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the dialog fires its native close event (Esc or backdrop)', () => {
    // jsdom does not synthesize a 'close' event from a real Esc keystroke
    // (the polyfilled HTMLDialogElement only fires the event from .close()),
    // so we dispatch the event directly. This is exactly what both Esc and
    // the <form method="dialog"> backdrop button drive in the runtime DOM.
    const onClose = vi.fn();
    render(() => <ShortcutsDialog isOpen={true} onClose={onClose} />);
    const dialog = screen.getByRole('dialog') as HTMLDialogElement;
    dialog.dispatchEvent(new Event('close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the "Press F1 any time to reopen" footer hint', () => {
    // The footer splits its body across a `<p>` containing a `<kbd>F1</kbd>`
    // child, so a single-text regex doesn't match a single text node. Query
    // the footer element directly and assert against its joined textContent.
    render(() => <ShortcutsDialog isOpen={true} onClose={() => {}} />);
    const footer = document.querySelector('footer');
    expect(footer).toBeTruthy();
    expect(footer?.textContent ?? '').toMatch(
      /Press.*F1.*any time to reopen this dialog/i,
    );
  });

  it('unmounts the dialog when isOpen flips from true to false', () => {
    const { container } = render(() => {
      const [open, setOpen] = createSignal(true);
      return (
        <>
          <button
            type="button"
            data-testid="toggle"
            onClick={() => setOpen((v) => !v)}
          >
            toggle
          </button>
          <ShortcutsDialog isOpen={open()} onClose={() => setOpen(false)} />
        </>
      );
    });
    expect(container.querySelector('dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('toggle'));
    expect(container.querySelector('dialog')).toBeNull();
  });
});
