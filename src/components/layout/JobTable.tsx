import { For, Show } from 'solid-js';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Icon } from '@iconify-icon/solid';
import type { RenderJob } from '../../core/types';
import { StatusBadge } from '../ui/StatusBadge';

export function JobTable(props: { jobs: RenderJob[] }) {
  return (
    <Show
      when={props.jobs.length > 0}
      fallback={
        <div class="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-base-300 bg-base-100 p-6 text-center">
          <Icon
            icon="lucide:inbox"
            class="mb-3 text-base-content/35"
            width="36"
            height="36"
          />
          <p class="font-medium">No jobs yet</p>
          <p class="mt-1 max-w-sm text-sm text-base-content/55">
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
            </tr>
          </thead>
          <tbody>
            <For each={props.jobs}>
              {(job) => (
                <tr class="border-b border-base-300/70">
                  <td class="min-w-64">
                    <div class="flex items-center gap-3">
                      <Show
                        when={job.video.thumbnailPath}
                        fallback={
                          <div class="h-11 w-16 rounded-md bg-base-300" />
                        }
                      >
                        <img
                          src={convertFileSrc(job.video.thumbnailPath!)}
                          class="h-11 w-16 rounded-md object-cover"
                          alt=""
                          loading="lazy"
                        />
                      </Show>
                      <div class="min-w-0">
                        <p class="truncate font-medium" title={job.video.name}>
                          {job.video.name}
                        </p>
                        <p
                          class="truncate text-xs text-base-content/50"
                          title={job.video.outputPath}
                        >
                          {job.video.outputPath}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td>
                    <StatusBadge state={job.state} />
                  </td>
                  <td
                    class="max-w-48 truncate text-sm text-base-content/65"
                    title={job.currentStep}
                  >
                    {job.currentStep}
                  </td>
                  <td>
                    <div class="flex items-center gap-2">
                      <div class="h-2 w-24 rounded-full bg-base-300 overflow-hidden">
                        <div
                          class="h-full bg-primary transition-all duration-300 ease-out"
                          style={{ width: `${job.progressPercent}%` }}
                        />
                      </div>
                      <span class="w-10 text-right font-mono text-xs text-base-content/60">
                        {job.progressPercent}%
                      </span>
                    </div>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
}
