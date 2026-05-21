// src/components/layout/LogViewer.tsx
import { createEffect, For, Show } from 'solid-js';
import { Icon } from '@iconify-icon/solid';
import { LogLine } from '../ui/LogLine';

export function LogViewer(props: { logs: string[] }) {
  let logContainerRef!: HTMLDivElement;

  createEffect(() => {
    props.logs.length;
    if (logContainerRef) {
      logContainerRef.scrollTop = logContainerRef.scrollHeight;
    }
  });

  return (
    <section class="panel flex min-h-[360px] min-w-0 flex-col overflow-hidden">
      <div class="flex items-center justify-between border-b border-base-300 px-4 py-3">
        <div class="flex items-center gap-2">
          <Icon
            icon="lucide:terminal"
            class="text-primary"
            width="18"
            height="18"
          />
          <h3 class="font-semibold">Logs</h3>
        </div>
        <span class="badge badge-ghost badge-sm">{props.logs.length}</span>
      </div>

      <div
        ref={logContainerRef}
        class="min-h-0 flex-1 overflow-y-auto bg-neutral p-3 font-mono text-xs leading-relaxed text-neutral-content custom-scrollbar"
      >
        <Show
          when={props.logs.length > 0}
          fallback={
            <div class="py-10 text-center text-neutral-content/55">
              No log output yet.
            </div>
          }
        >
          <For each={props.logs}>{(line) => <LogLine text={line} />}</For>
        </Show>
      </div>
    </section>
  );
}
