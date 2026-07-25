import { createSignal, Index, Show } from 'solid-js';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Icon } from '@iconify-icon/solid';
import { TAURI_COMMANDS } from '../../core/constants';
import type { JobProgress } from '../../core/types';
import { StatusBadge } from '../ui/StatusBadge';

const revealFile = async (path: string) => {
  try {
    await invoke(TAURI_COMMANDS.revealInExplorer, { path });
  } catch (e) {
    console.error('Failed to reveal file:', e);
  }
};

export function JobTable(props: { jobs: JobProgress[] }) {
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
                // Track thumbnail load errors per-row so we can show
                // the placeholder instead of a broken-image hole.
                const [thumbError, setThumbError] = createSignal(false);
                return (
                  <tr class="border-b border-base-300/70 hover:bg-base-content/5 transition-colors">
                    <td class="min-w-64">
                      <div class="flex items-center gap-3">
                        <Show
                          when={job().thumbnailPath && !thumbError()}
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
                            src={convertFileSrc(job().thumbnailPath!)}
                            class="h-11 w-16 rounded-md object-cover"
                            alt=""
                            loading="lazy"
                            onError={() => setThumbError(true)}
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
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs"
                        title="Reveal in folder"
                        disabled={job().state !== 'done'}
                        onClick={() => revealFile(job().outputPath)}
                      >
                        <Icon
                          icon="lucide:folder-open"
                          width="16"
                          height="16"
                        />
                      </button>
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
