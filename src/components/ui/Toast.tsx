import { For } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Icon } from '@iconify-icon/solid';
import { dismissToast, type ToastVariant, useToasts } from '../../core/toast';

/**
 * Maps a toast variant to its DaisyUI `alert` modifier + lucide icon.
 * Centralised so the icon and colour stay in sync if either changes.
 */
const variantMeta: Record<
  ToastVariant,
  { class: string; icon: string; role: 'status' | 'alert' }
> = {
  info: {
    class: 'alert-info',
    icon: 'lucide:info',
    role: 'status',
  },
  success: {
    class: 'alert-success',
    icon: 'lucide:circle-check',
    role: 'status',
  },
  warning: {
    class: 'alert-warning',
    icon: 'lucide:triangle-alert',
    role: 'alert',
  },
  error: {
    class: 'alert-error',
    icon: 'lucide:circle-x',
    role: 'alert',
  },
};

/**
 * Render all live toasts in a bottom-right portal.
 *
 * Mounted once near the top of the app. Positioned with DaisyUI's `toast`
 * utility so it sits over the main content without colliding with the
 * window controls. z-index 60 sits above modals (50) so feedback remains
 * visible even when a dialog is open.
 */
export function ToastViewport() {
  const toasts = useToasts();

  return (
    <Portal>
      <div class="toast toast-end toast-bottom z-[60] pointer-events-none">
        <For each={toasts()}>
          {(t) => {
            const meta = variantMeta[t.variant];
            return (
              <div
                role={meta.role}
                class={`alert ${meta.class} shadow-lg pointer-events-auto max-w-sm animate-fadeIn gap-2`}
              >
                <Icon icon={meta.icon} width="18" height="18" />
                <span class="flex-1 truncate">{t.message}</span>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs btn-square"
                  aria-label="Dismiss notification"
                  onClick={() => dismissToast(t.id)}
                >
                  <Icon icon="lucide:x" width="14" height="14" />
                </button>
              </div>
            );
          }}
        </For>
      </div>
    </Portal>
  );
}
