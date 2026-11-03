import { createEffect, type Accessor } from 'solid-js';
import { Icon } from '../ui/Icon';
import { AppHeader } from './AppHeader';
import { HardwareInfo } from '../ui/HardwareInfo';
import { OverallProgress } from '../ui/OverallProgress';
import type { Pipeline } from '../../context/pipeline';
import type { AppTabId } from '../../hooks/useAppShortcuts';

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
