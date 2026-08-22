import { Show } from 'solid-js';
import { Icon } from '@iconify-icon/solid';
import type { Accessor } from 'solid-js';

/**
 * Output folder selector — extracted from {@link SettingsCard}.
 *
 * Renders a drop-zone-aware button to pick a folder, and when a path is
 * selected shows the path with an "Open in Explorer" action.
 */
export function OutputFolderSelector(props: {
  outputPath: Accessor<string>;
  dropClass: string;
  onChooseFolder: () => void;
  onReveal: () => void;
}) {
  return (
    <div class={`flex min-h-full flex-col gap-3 rounded-lg ${props.dropClass}`}>
      <button
        type="button"
        class="flex min-h-36 w-full flex-col items-start justify-between rounded-lg border border-dashed border-accent/35 bg-accent/5 p-4 text-left text-accent transition-colors hover:border-accent"
        onClick={props.onChooseFolder}
      >
        <span class="flex h-10 w-10 items-center justify-center rounded-lg bg-base-100 text-current shadow-sm">
          <Icon icon="lucide:folder-output" width="20" height="20" />
        </span>

        <span class="mt-4 block">
          <span class="block text-sm font-semibold text-base-content">
            Output folder
          </span>
          <span class="mt-1 block text-xs text-base-content/60">
            {props.outputPath() ? 'Destination selected' : 'Choose folder'}
          </span>
        </span>
      </button>

      <Show
        when={props.outputPath()}
        fallback={
          <div class="rounded-lg border border-base-300 bg-base-100 px-3 py-2 text-xs text-base-content/60">
            No folder selected.
          </div>
        }
      >
        <div class="rounded-lg border border-base-300 bg-base-100 p-3">
          <p class="mb-1 text-xs font-medium text-base-content/70">
            Selected folder
          </p>
          <p
            class="truncate text-xs text-base-content/80"
            title={props.outputPath()}
          >
            {props.outputPath()}
          </p>
          <button
            type="button"
            class="btn btn-outline btn-xs mt-2"
            onClick={props.onReveal}
          >
            <Icon icon="lucide:folder-open" width="14" height="14" />
            Open in Explorer
          </button>
        </div>
      </Show>
    </div>
  );
}
