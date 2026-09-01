import { Show, Index } from 'solid-js';
import { Icon } from '@iconify-icon/solid';
import { Skeleton } from './Skeleton';

interface HardwareData {
  cpuModel: string;
  gpuModel: string;
  totalRamGB: number;
  av1Supported: boolean;
}

function HardwareRow(props: { icon: string; label: string; value: string }) {
  return (
    <div class="flex items-start gap-3 rounded-lg border border-base-300/60 bg-base-100/50 p-2.5">
      <Icon
        icon={props.icon}
        class="mt-0.5 shrink-0 text-base-content/45"
        width="16"
        height="16"
      />
      <div class="min-w-0">
        <p class="text-[10px] font-medium uppercase tracking-wider text-base-content/55">
          {props.label}
        </p>
        <p class="truncate text-[13px]" title={props.value}>
          {props.value}
        </p>
      </div>
    </div>
  );
}

/** Placeholder rows shown while hardware detection is in progress. */
function SkeletonRows() {
  const rows = [
    { icon: 'lucide:chip', label: 'CPU' },
    { icon: 'lucide:monitor-play', label: 'GPU' },
    { icon: 'lucide:memory-stick', label: 'RAM' },
  ];
  return (
    <div class="grid grid-cols-1 gap-2">
      <Index each={rows}>
        {(row) => (
          <div class="flex items-start gap-3 rounded-lg border border-base-300/60 bg-base-100/50 p-2.5">
            <Icon
              icon={row().icon}
              class="mt-0.5 shrink-0 text-base-content/20"
              width="16"
              height="16"
            />
            <div class="flex-1 space-y-1.5">
              <Skeleton class="h-2.5 w-8" />
              <Skeleton class="h-4 w-40" />
            </div>
          </div>
        )}
      </Index>
    </div>
  );
}

export function HardwareInfo(props: { info: HardwareData | null }) {
  return (
    <section class="panel">
      <div class="card-body p-4">
        <div class="mb-3 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Icon
              icon="lucide:cpu"
              class="text-base-content/50"
              width="16"
              height="16"
            />
            <h3 class="text-sm font-semibold">Hardware</h3>
          </div>
          <Show
            when={props.info}
            fallback={<Skeleton variant="text" class="h-5 w-20" />}
          >
            {(info) => (
              <span
                class={`badge badge-sm ${
                  info().av1Supported ? 'badge-success' : 'badge-ghost'
                }`}
              >
                AV1 {info().av1Supported ? 'ready' : 'off'}
              </span>
            )}
          </Show>
        </div>

        <Show when={props.info} fallback={<SkeletonRows />}>
          {(info) => (
            <div class="grid grid-cols-1 gap-2">
              <HardwareRow
                icon="lucide:chip"
                label="CPU"
                value={info().cpuModel}
              />
              <HardwareRow
                icon="lucide:monitor-play"
                label="GPU"
                value={info().gpuModel}
              />
              <HardwareRow
                icon="lucide:memory-stick"
                label="RAM"
                value={`${info().totalRamGB} GB`}
              />
            </div>
          )}
        </Show>
      </div>
    </section>
  );
}
