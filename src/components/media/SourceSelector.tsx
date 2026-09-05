import { createSignal, For, Show } from 'solid-js';
import { dirname } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { Icon } from '../ui/Icon';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { createLogger } from '../../core/logger';

interface SourceSelectorProps {
  label: string;
  allowedExtensions: string[];
  value: readonly string[];
  onChange: (paths: string[] | null) => void;
  icon: string;
  themeColor: 'primary' | 'secondary' | 'accent' | 'info';
}

// Replaces 1 ad-hoc console.warn call; see `src/core/logger.ts`.
const log = createLogger('SourceSelector');

// Gentle per-source identity lives on the icon tile only — the card itself
// stays neutral so the canvas reads as a calm, true-dark workspace.
const tileTint = {
  primary: 'bg-primary/10 text-primary',
  secondary: 'bg-secondary/10 text-secondary',
  accent: 'bg-accent/10 text-accent',
  info: 'bg-info/10 text-info',
};

/** Last path segment for display — module-level so it isn't recreated per render. */
const fileName = (path: string) =>
  path.replace(/\\/g, '/').split('/').pop() || path;

export function SourceSelector(props: SourceSelectorProps) {
  const [lastDir, setLastDir] = createSignal<string>();
  const [showClearConfirm, setShowClearConfirm] = createSignal(false);

  const browseFiles = async () => {
    let currentDefault = lastDir();
    if (!currentDefault && props.value.length > 0) {
      try {
        const firstPath = props.value[0];
        if (firstPath) currentDefault = await dirname(firstPath);
      } catch (e) {
        log.warn('Could not get dirname', e);
      }
    }

    const selected = await open({
      multiple: true,
      defaultPath: currentDefault,
      filters: [
        {
          name: props.label,
          extensions: props.allowedExtensions.map((ext) =>
            ext.replace('.', ''),
          ),
        },
      ],
    });

    if (!selected) return;

    const files = (Array.isArray(selected) ? selected : [selected]) as string[];
    if (files.length === 0) return;

    try {
      const firstFile = files[0];
      if (firstFile) setLastDir(await dirname(firstFile));
    } catch (err) {
      log.warn('Could not cache last dir', err);
    }

    props.onChange(files);
  };

  return (
    <div class="flex h-full flex-col gap-2.5">
      <button
        type="button"
        class="group flex min-h-36 w-full flex-col items-start justify-between rounded-xl border border-dashed border-base-300/70 bg-base-100/40 p-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-primary/[0.04] hover:shadow-lg hover:shadow-black/20"
        onClick={browseFiles}
      >
        <span
          class={`flex h-9 w-9 items-center justify-center rounded-lg bg-base-200/80 ring-1 ring-base-300/50 ${tileTint[props.themeColor]}`}
        >
          <Icon icon={props.icon} width="19" height="19" />
        </span>

        <span class="mt-4 block">
          <span class="block text-sm font-semibold text-base-content">
            {props.label}
          </span>
          <span class="mt-0.5 block text-xs text-base-content/50">
            {props.value.length > 0
              ? `${props.value.length} selected`
              : 'Choose files'}
          </span>
        </span>
      </button>

      <Show
        when={props.value.length > 0}
        fallback={
          <div class="rounded-lg border border-base-300/60 bg-base-100/50 px-3 py-2 text-[11px] text-base-content/50">
            {props.allowedExtensions.join(', ')}
          </div>
        }
      >
        <div class="overflow-hidden rounded-lg border border-base-300/70 bg-base-100/60">
          <div class="flex items-center justify-between border-b border-base-300/70 px-3 py-2">
            <span class="text-xs font-medium text-base-content/70">
              Selected files
            </span>
            <button
              type="button"
              class="btn btn-ghost btn-xs text-accent"
              onClick={() => setShowClearConfirm(true)}
            >
              Clear
            </button>
          </div>
          <div class="max-h-28 overflow-y-auto p-2 custom-scrollbar">
            <For each={props.value.slice(0, 8)}>
              {(file) => (
                <div
                  class="truncate rounded-md px-2 py-1 text-xs text-base-content/80 hover:bg-base-content/5 transition-colors"
                  title={file}
                >
                  {fileName(file)}
                </div>
              )}
            </For>
            <Show when={props.value.length > 8}>
              <div class="px-2 py-1 text-xs text-base-content/60">
                +{props.value.length - 8} more
              </div>
            </Show>
          </div>
        </div>
      </Show>

      <ConfirmDialog
        isOpen={showClearConfirm()}
        title={`Clear ${props.label}`}
        message={`Are you sure you want to clear all ${props.label.toLowerCase()}?`}
        confirmLabel="Clear"
        onConfirm={() => {
          setShowClearConfirm(false);
          props.onChange(null);
        }}
        onCancel={() => setShowClearConfirm(false)}
      />
    </div>
  );
}
