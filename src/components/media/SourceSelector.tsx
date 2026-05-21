// src/components/media/SourceSelector.tsx
import { createSignal, For, Show } from 'solid-js';
import { dirname } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { Icon } from '@iconify-icon/solid';

interface SourceSelectorProps {
  label: string;
  allowedExtensions: string[];
  value: string[];
  onChange: (paths: string[] | null) => void;
  icon: string;
  themeColor: 'primary' | 'secondary' | 'accent' | 'info';
}

const colorClass = {
  primary: 'border-primary/35 bg-primary/5 text-primary hover:border-primary',
  secondary:
    'border-secondary/35 bg-secondary/5 text-secondary hover:border-secondary',
  accent: 'border-accent/35 bg-accent/5 text-accent hover:border-accent',
  info: 'border-info/35 bg-info/5 text-info hover:border-info',
};

export function SourceSelector(props: SourceSelectorProps) {
  const [lastDir, setLastDir] = createSignal<string>();

  const fileName = (path: string) =>
    path.replace(/\\/g, '/').split('/').pop() || path;

  const browseFiles = async () => {
    let currentDefault = lastDir();
    if (!currentDefault && props.value.length > 0) {
      try {
        currentDefault = await dirname(props.value[0]);
      } catch (e) {
        console.warn('Could not get dirname', e);
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
      setLastDir(await dirname(files[0]));
    } catch {}

    props.onChange(files);
  };

  return (
    <div class="flex h-full flex-col gap-3">
      <button
        type="button"
        class={`group flex min-h-36 w-full flex-col items-start justify-between rounded-lg border border-dashed p-4 text-left transition-colors ${colorClass[props.themeColor]}`}
        onClick={browseFiles}
      >
        <span class="flex h-10 w-10 items-center justify-center rounded-lg bg-base-100 text-current shadow-sm">
          <Icon icon={props.icon} width="20" height="20" />
        </span>

        <span class="mt-4 block">
          <span class="block text-sm font-semibold text-base-content">
            {props.label}
          </span>
          <span class="mt-1 block text-xs text-base-content/60">
            {props.value.length > 0
              ? `${props.value.length} selected`
              : 'Choose files'}
          </span>
        </span>
      </button>

      <Show
        when={props.value.length > 0}
        fallback={
          <div class="rounded-lg border border-base-300 bg-base-100 px-3 py-2 text-xs text-base-content/55">
            {props.allowedExtensions.join(', ')}
          </div>
        }
      >
        <div class="rounded-lg border border-base-300 bg-base-100">
          <div class="flex items-center justify-between border-b border-base-300 px-3 py-2">
            <span class="text-xs font-medium text-base-content/70">
              Selected files
            </span>
            <button
              type="button"
              class="btn btn-ghost btn-xs text-error"
              onClick={() => props.onChange(null)}
            >
              Clear
            </button>
          </div>
          <div class="max-h-28 overflow-y-auto p-2 custom-scrollbar">
            <For each={props.value.slice(0, 8)}>
              {(file) => (
                <div
                  class="truncate rounded-md px-2 py-1 text-xs text-base-content/80"
                  title={file}
                >
                  {fileName(file)}
                </div>
              )}
            </For>
            <Show when={props.value.length > 8}>
              <div class="px-2 py-1 text-xs text-base-content/55">
                +{props.value.length - 8} more
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
