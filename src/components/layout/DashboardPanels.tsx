import { createEffect, type Accessor, type Setter } from 'solid-js';
import { Icon } from '@iconify-icon/solid';
import {
  AppHeader,
  HardwareInfo,
  JobTable,
  LogViewer,
  OverallProgress,
} from '../index';
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

export function InspectorRail(props: {
  pipeline: Pipeline;
  renderEstimate: Accessor<string | undefined>;
  activeTab: Accessor<AppTabId>;
}) {
  return (
    <aside
      class={`flex max-h-[40vh] shrink-0 flex-col gap-4 overflow-y-auto border-t border-base-300/60 bg-base-100/40 p-4 custom-scrollbar xl:max-h-none xl:w-80 xl:border-t-0 xl:border-l ${props.activeTab() === 'renderer' ? '' : 'hidden xl:flex'}`}
    >
      <AppHeader
        running={props.pipeline.running()}
        paused={props.pipeline.paused()}
        onStart={props.pipeline.startRender}
        onResume={props.pipeline.resumeRender}
        onCancel={props.pipeline.cancelRender}
        onPause={props.pipeline.pauseRender}
        canStart={props.pipeline.canStart()}
        disabledReason={props.pipeline.disabledReason()}
        renderEstimate={props.renderEstimate()}
      />
      <OverallProgress
        value={props.pipeline.overallProgress()}
        eta={props.pipeline.overallEta()}
        active={
          props.pipeline.running() ||
          props.pipeline.paused() ||
          props.pipeline.overallProgress() > 0
        }
      />
      <HardwareInfo info={props.pipeline.hardwareInfo()} />
      <MiniLogViewer logs={props.pipeline.logs()} />
    </aside>
  );
}

function MiniLogViewer(props: { logs: string[] }) {
  let scrollRef!: HTMLDivElement;
  const visible = () => props.logs.slice(-8);

  createEffect(() => {
    props.logs;
    requestAnimationFrame(() => {
      if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight;
    });
  });

  return (
    <section class="panel flex min-h-0 flex-col overflow-hidden">
      <div class="flex items-center gap-2 border-b border-base-300/70 px-3.5 py-2 shrink-0">
        <Icon
          icon="lucide:terminal"
          class="text-base-content/50"
          width="14"
          height="14"
        />
        <span class="text-xs font-medium text-base-content/80">
          Recent logs
        </span>
        <span class="ml-auto rounded-full bg-base-300/60 px-1.5 py-0.5 font-mono text-[10px] text-base-content/60">
          {props.logs.length}
        </span>
      </div>
      <div
        ref={scrollRef}
        class="max-h-40 overflow-y-auto border-t border-base-300/40 bg-base-200/60 p-2.5 font-mono text-xs leading-relaxed text-base-content/70 custom-scrollbar"
      >
        {visible().length === 0 ? (
          <p class="py-2 text-center text-[0.65rem] text-base-content/55">
            Waiting for logs...
          </p>
        ) : (
          visible().map((line) => (
            <pre class="whitespace-pre-wrap break-words">
              <code>{line}</code>
            </pre>
          ))
        )}
      </div>
    </section>
  );
}
