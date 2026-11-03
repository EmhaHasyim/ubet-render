import { type Setter } from 'solid-js';
import { Icon } from '../ui/Icon';
import { JobTable } from './JobTable';
import { LogViewer } from './LogViewer';
import type { Pipeline } from '../../context/pipeline';
import type { AppTabId } from '../../hooks/useAppShortcuts';

export function ActivityView(props: {
  pipeline: Pipeline;
  setActiveTab: Setter<AppTabId>;
}) {
  return (
    <div class="flex flex-1 flex-col overflow-hidden p-4 md:p-6">
      <div class="mx-auto flex w-full max-w-[1760px] flex-1 flex-col gap-4 overflow-hidden">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between shrink-0">
          <div class="flex items-center gap-2.5">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon icon="lucide:list-checks" width="16" height="16" />
            </div>
            <div>
              <h2 class="text-[17px] font-semibold tracking-tight">Activity</h2>
              <p class="text-[13px] text-base-content/50">Jobs and logs.</p>
            </div>
          </div>
          <button
            class="btn btn-primary btn-sm gap-2"
            onClick={() => props.setActiveTab('renderer')}
          >
            <Icon icon="lucide:arrow-left" width="15" height="15" />
            Back to setup
          </button>
        </div>

        <div class="grid flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_380px] 2xl:grid-cols-[minmax(0,1fr)_440px]">
          <section class="panel flex min-h-0 min-w-0 flex-col overflow-hidden">
            <div class="flex items-center justify-between border-b border-base-300/70 px-4 py-3 shrink-0">
              <div class="flex items-center gap-2">
                <Icon
                  icon="lucide:layers-3"
                  class="text-base-content/50"
                  width="16"
                  height="16"
                />
                <h3 class="text-sm font-semibold">Jobs</h3>
              </div>
              <span class="rounded-full bg-base-300/60 px-2 py-0.5 text-[11px] font-medium text-base-content/60">
                {props.pipeline.jobs().length} total
              </span>
            </div>
            <div class="min-h-0 flex-1 overflow-auto p-3 custom-scrollbar">
              <JobTable
                jobs={props.pipeline.jobs()}
                onRetry={props.pipeline.retryJob}
              />
            </div>
          </section>
          <LogViewer logs={props.pipeline.logs()} />
        </div>
      </div>
    </div>
  );
}
