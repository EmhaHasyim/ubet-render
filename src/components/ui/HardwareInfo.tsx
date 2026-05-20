import { Show } from 'solid-js';
import { Icon } from '@iconify-icon/solid';

interface HardwareData {
  cpuModel: string;
  gpuModel: string;
  totalRamGB: number;
  av1Supported: boolean;
}

function HardwareRow(props: { icon: string; label: string; value: string }) {
  return (
    <div class="flex items-start gap-3 rounded-lg border border-base-300 bg-base-100 p-3">
      <Icon icon={props.icon} class="mt-0.5 text-base-content/55" width="17" height="17" />
      <div class="min-w-0">
        <p class="text-xs font-medium uppercase text-base-content/45">{props.label}</p>
        <p class="truncate text-sm" title={props.value}>{props.value}</p>
      </div>
    </div>
  );
}

export function HardwareInfo(props: { info: HardwareData | null }) {
  return (
    <section class="panel p-4">
      <div class="mb-3 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <Icon icon="lucide:cpu" class="text-primary" width="18" height="18" />
          <h3 class="font-semibold">Hardware</h3>
        </div>
        <Show when={props.info} fallback={<span class="loading loading-spinner loading-sm" />}>
          {(info) => (
            <span class={`badge badge-sm ${info().av1Supported ? 'badge-success' : 'badge-ghost'}`}>
              AV1 {info().av1Supported ? 'ready' : 'off'}
            </span>
          )}
        </Show>
      </div>

      <Show
        when={props.info}
        fallback={<div class="rounded-lg border border-base-300 bg-base-100 p-3 text-sm text-base-content/60">Detecting system hardware...</div>}
      >
        {(info) => (
          <div class="grid grid-cols-1 gap-2">
            <HardwareRow icon="lucide:chip" label="CPU" value={info().cpuModel} />
            <HardwareRow icon="lucide:monitor-play" label="GPU" value={info().gpuModel} />
            <HardwareRow icon="lucide:memory-stick" label="RAM" value={`${info().totalRamGB} GB`} />
          </div>
        )}
      </Show>
    </section>
  );
}
