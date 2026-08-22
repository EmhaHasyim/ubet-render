import { createSignal, Index, Show } from 'solid-js';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Icon } from '@iconify-icon/solid';
import { TAURI_COMMANDS } from '../../core/constants';
import type { JobProgress } from '../../core/types';
import { StatusBadge } from '../ui/StatusBadge';
import { createLogger } from '../../core/logger';

// Replaces 1 ad-hoc console.error call; see `src/core/logger.ts`.
const log = createLogger('JobTable');

const revealFile = async (path: string) => {
  try {
    await invoke(TAURI_COMMANDS.revealInExplorer, { path });
  } catch (e) {
    log.error('Failed to reveal file:', e);
  }
};

export function JobTable(props: {
  jobs: JobProgress[];
  /**
   * Optional retry handler invoked per failed-job row. When provided,
   * an additional action button appears next to "Reveal in folder" for
   * jobs whose `state === 'error'`. Until the backend supports per-job
   * requeue (a v0.3+ change), the handler triggers a full resume from
   * the on-disk state file.
   */
  onRetry?: () => void;
}) {
  // Track thumbnails that failed to load in a stable Set keyed by path.
  // A per-row `createSignal` inside the `<Index>` callback would be
  // recreated on every jobs update (each Progress event replaces the array
  // with fresh item objects), resetting the error state and causing the row
  // to flicker between the placeholder and a broken image.
  const [failedThumbs, setFailedThumbs] = createSignal<ReadonlySet<string>>(
    new Set(),
  );

  const markThumbFailed = (path: string) => {
    setFailedThumbs((cur) => {
      if (cur.has(path)) return cur;
      const next = new Set(cur);
      next.add(path);
      return next;
    });
  };

  return (
    <Show
      when={props.jobs.length > 0}
      fallback={
        <div class="card card-border bg-base-100 flex min-h-64 flex-col items-center justify-center border-dashed p-6 text-center">
          <Icon
            icon="lucide:inbox"
            class="mb-3 text-base-content/60"
            width="36"
            height="36"
          />
          <p class="font-medium">No jobs yet</p>
          <p class="mt-1 max-w-sm text-sm text-base-content/60">
            Queue is empty.
          </p>
        </div>
      }
    >
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr class="border-b border-base-300">
              <th>Video</th>
              <th>Status</th>
              <th>Step</th>
              <th class="w-40">Progress</th>
              <th class="w-20">Actions</th>
            </tr>
          </thead>
          <tbody>
            <Index each={props.jobs}>
              {(job) => {
                const thumbPath = job().thumbnailPath;
                const thumbFailed = () =>
                  thumbPath !== null && failedThumbs().has(thumbPath);

                return (
                  <tr class="border-b border-base-300/70 hover:bg-base-content/5 transition-colors">
                    <td class="min-w-64">
                      <div class="flex items-center gap-3">
                        <Show
                          when={thumbPath && !thumbFailed()}
                          fallback={
                            <div class="h-11 w-16 flex items-center justify-center rounded-md bg-base-300 text-base-content/40">
                              <Icon
                                icon="lucide:file-video"
                                width="16"
                                height="16"
                              />
                            </div>
                          }
                        >
                          <img
                            src={convertFileSrc(thumbPath!)}
                            class="h-11 w-16 rounded-md object-cover"
                            alt=""
                            loading="lazy"
                            onError={() =>
                              thumbPath && markThumbFailed(thumbPath)
                            }
                          />
                        </Show>
                        <div class="min-w-0">
                          <p class="truncate font-medium" title={job().name}>
                            {job().name}
                          </p>
                          <p
                            class="truncate text-xs text-base-content/60"
                            title={job().outputPath}
                          >
                            {job().outputPath}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <StatusBadge state={job().state} />
                    </td>
                    <td
                      class="max-w-48 truncate text-sm text-base-content/60"
                      title={job().currentStep}
                    >
                      {job().currentStep}
                    </td>
                    <td>
                      <div class="flex items-center gap-2">
                        <progress
                          class="progress progress-primary w-24 h-2"
                          value={job().progressPercent}
                          max="100"
                          aria-label={`${job().name} progress`}
                        />
                        <span class="w-10 text-right font-mono text-xs text-base-content/60">
                          {job().progressPercent}%
                        </span>
                      </div>
                    </td>
                    <td>
                      <div class="flex items-center gap-1">
                        <button
                          type="button"
                          class="btn btn-ghost btn-xs"
                          title="Reveal in folder"
                          aria-label={`Reveal ${job().name} in folder`}
                          disabled={job().state !== 'done'}
                          onClick={() => revealFile(job().outputPath)}
                        >
                          <Icon
                            icon="lucide:folder-open"
                            width="16"
                            height="16"
                          />
                        </button>
                        <Show when={props.onRetry && job().state === 'error'}>
                          <button
                            type="button"
                            class="btn btn-ghost btn-xs text-warning"
                            title="Retry failed job"
                            aria-label={`Retry failed job: ${job().name}`}
                            onClick={() => props.onRetry?.()}
                          >
                            <Icon
                              icon="lucide:rotate-cw"
                              width="16"
                              height="16"
                            />
                          </button>
                        </Show>
                      </div>
                    </td>
                  </tr>
                );
              }}
            </Index>
          </tbody>
        </table>
      </div>
    </Show>
  );
}
