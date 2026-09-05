import { Show } from 'solid-js';
import { Icon } from '../ui/Icon';
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
    <div
      class={`flex min-h-full flex-col gap-2.5 rounded-xl ${props.dropClass}`}
    >
      <button
        type="button"
        class="flex min-h-36 w-full flex-col items-start justify-between rounded-xl border border-dashed border-base-300/70 bg-base-100/40 p-4 text-left text-base-content/80 transition-all duration-150 hover:-translate-y-0.5 hover:border-accent/40 hover:bg-accent/[0.04] hover:shadow-lg hover:shadow-black/20"
        onClick={props.onChooseFolder}
      >
        <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent ring-1 ring-base-300/50">
          <Icon icon="lucide:folder-output" width="19" height="19" />
        </span>

        <span class="mt-4 block">
          <span class="block text-sm font-semibold text-base-content">
            Output folder
          </span>
          <span class="mt-0.5 block text-xs text-base-content/50">
            {props.outputPath() ? 'Destination selected' : 'Choose folder'}
          </span>
        </span>
      </button>

      <Show
        when={props.outputPath()}
        fallback={
          <div class="rounded-lg border border-base-300/60 bg-base-100/50 px-3 py-2 text-[11px] text-base-content/50">
            No folder selected.
          </div>
        }
      >
        <div class="rounded-lg border border-base-300/70 bg-base-100/60 p-3">
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
