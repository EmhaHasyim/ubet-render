import { Show, For, createEffect } from 'solid-js';
import { Icon } from './Icon';
import { rememberFocus } from '../../core/focus';

/**
 * Single source of truth for keyboard-shortcut documentation.
 * Tracked in one place so the dialog can never drift away from
 * `App.tsx`'s keydown handler. Each entry is `{ keys, label, group }`
 * grouped semantically for visual sectioning in the dialog.
 */
export interface ShortcutEntry {
  keys: string[];
  label: string;
  // Optional grouping keeps related shortcuts visually adjacent in the dialog.
  group?: 'Window' | 'Render' | 'General';
}

export const SHORTCUTS: ShortcutEntry[] = [
  // Window controls — global, regardless of focus location.
  { group: 'Window', keys: ['F11'], label: 'Toggle fullscreen' },
  { group: 'Window', keys: ['Ctrl', 'W'], label: 'Hide window to tray' },
  {
    group: 'Window',
    keys: ['Ctrl', 'Shift', 'M'],
    label: 'Minimize window',
  },

  // Rendering — active when the renderer is mounted.
  { group: 'Render', keys: ['Ctrl', 'Enter'], label: 'Start render' },
  { group: 'Render', keys: ['Ctrl', 'P'], label: 'Pause / Resume render' },
  { group: 'Render', keys: ['Ctrl', 'Shift', 'C'], label: 'Cancel render' },
  { group: 'Render', keys: ['Ctrl', '1'], label: 'Open Render tab' },
  { group: 'Render', keys: ['Ctrl', '2'], label: 'Open Activity tab' },

  // Help / meta
  { group: 'General', keys: ['F1'], label: 'Show this help dialog' },
  { group: 'General', keys: ['Esc'], label: 'Close dialogs and menus' },
];

// Group shortcuts by `group` while preserving declaration order. Computed
// once at module load — SHORTCUTS is effectively a constant — so the
// dialog content is stable across renders and the React-style use of
// `.map()` (instead of <For>) is safe here.
const GROUPED_SHORTCUTS: ReadonlyArray<{
  group: NonNullable<ShortcutEntry['group']>;
  items: ShortcutEntry[];
}> = (() => {
  const order: Array<NonNullable<ShortcutEntry['group']>> = [
    'Window',
    'Render',
    'General',
  ];
  return order
    .map((g) => ({
      group: g,
      items: SHORTCUTS.filter((s) => s.group === g),
    }))
    .filter((section) => section.items.length > 0);
})();

/**
 * Display the registered keyboard shortcuts in a modal dialog.
 *
 * Uses the same `<dialog>` + `rememberFocus()` pattern as
 * `ConfirmDialog` so focus history stays intact when the user closes
 * the dialog with either Esc / backdrop click or the close button.
 *
 * Rendered once at the top of `App.tsx`. Visibility is controlled by
 * the `isOpen` prop — when false, the dialog is unmounted by the
 * surrounding `<Show>` so it costs nothing when hidden.
 */
export function ShortcutsDialog(props: {
  isOpen: boolean;
  onClose: () => void;
}) {
  let dialogRef: HTMLDialogElement | undefined;
  // Captured the moment the dialog opens; consumed by the dialog's
  // `close` event handler so the trigger (typically the F1 keystroke
  // on `<body>`) regains focus when the dialog closes — same a11y
  // pattern as `ConfirmDialog`.
  let returnFocus: (() => void) | null = null;

  createEffect(() => {
    if (props.isOpen && dialogRef) {
      returnFocus = rememberFocus();
      dialogRef.showModal();
    } else if (!props.isOpen && dialogRef?.open) {
      dialogRef.close();
    }
  });

  const handleCloseClick = () => {
    if (dialogRef?.open) {
      dialogRef.close();
      // Most close paths (Esc, backdrop, our button) all go through
      // the dialog's native close event which fires onClose below. We
      // don't double-fire props.onClose() here — let the dialog own it.
    } else {
      props.onClose();
    }
  };

  return (
    <Show when={props.isOpen}>
      <dialog
        ref={dialogRef}
        class="modal modal-bottom sm:modal-middle"
        aria-labelledby="shortcuts-dialog-title"
        onClose={() => {
          returnFocus?.();
          returnFocus = null;
          props.onClose();
        }}
      >
        <div class="modal-box max-w-lg border border-base-300 bg-base-100">
          <header class="flex items-center justify-between gap-3 pb-3 border-b border-base-300">
            <div class="flex items-center gap-2">
              <Icon
                icon="lucide:keyboard"
                class="text-primary"
                width="20"
                height="20"
              />
              <h2 id="shortcuts-dialog-title" class="text-base font-semibold">
                Keyboard shortcuts
              </h2>
            </div>
            <button
              type="button"
              class="btn btn-ghost btn-xs btn-square"
              aria-label="Close shortcuts dialog"
              onClick={handleCloseClick}
            >
              <Icon icon="lucide:x" width="14" height="14" />
            </button>
          </header>

          <div class="space-y-4 pt-3 max-h-[60vh] overflow-y-auto custom-scrollbar">
            <For each={GROUPED_SHORTCUTS}>
              {(section) => (
                <section>
                  <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-base-content/60">
                    {section.group}
                  </h3>
                  <ul class="divide-y divide-base-300/70">
                    <For each={section.items}>
                      {(entry) => (
                        <li class="flex items-center justify-between gap-3 py-1.5">
                          <span class="text-sm text-base-content/80">
                            {entry.label}
                          </span>
                          <span class="flex items-center gap-1">
                            <For each={entry.keys}>
                              {(k, i) => (
                                <>
                                  {i() > 0 && (
                                    <span class="text-base-content/40 text-xs">
                                      +
                                    </span>
                                  )}
                                  <kbd class="kbd kbd-sm font-mono">{k}</kbd>
                                </>
                              )}
                            </For>
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
          </div>

          <footer class="mt-4 flex items-center justify-between gap-2 border-t border-base-300 pt-3">
            <p class="text-xs text-base-content/60">
              Press <kbd class="kbd kbd-xs">F1</kbd> any time to reopen this
              dialog.
            </p>
            <button
              type="button"
              class="btn btn-sm"
              data-testid="shortcuts-close"
              onClick={handleCloseClick}
            >
              Close
            </button>
          </footer>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button>close</button>
        </form>
      </dialog>
    </Show>
  );
}
