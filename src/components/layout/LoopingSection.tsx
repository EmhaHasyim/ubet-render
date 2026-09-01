import { Show } from 'solid-js';
import { CollapsibleSection } from './CollapsibleSection';
import type { Accessor } from 'solid-js';

/**
 * Looping settings: mode (duration/count), minimum duration, repeat count.
 * Content for the "Looping" collapsible section.
 */
export function LoopingSection(props: {
  loopMode: Accessor<'duration' | 'count'>;
  minDurationHours: Accessor<number>;
  loopCount: Accessor<number>;
  onModeChange: (v: 'duration' | 'count') => void;
  onDurationChange: (v: number) => void;
  onCountChange: (v: number) => void;
}) {
  return (
    <CollapsibleSection step={4} title="Looping">
      <div class="fieldset p-0">
        <span class="fieldset-legend">Repeat mode</span>
        <div class="join w-full">
          <input
            type="radio"
            class="btn join-item btn-outline flex-1"
            name="loopMode"
            value="duration"
            checked={props.loopMode() === 'duration'}
            onChange={() => props.onModeChange('duration')}
            aria-label="By Duration"
          />
          <input
            type="radio"
            class="btn join-item btn-outline flex-1"
            name="loopMode"
            value="count"
            checked={props.loopMode() === 'count'}
            onChange={() => props.onModeChange('count')}
            aria-label="By Count"
          />
        </div>
      </div>

      <Show when={props.loopMode() === 'duration'}>
        <label class="form-control">
          <span class="label py-1">
            <span class="label-text font-medium">Minimum duration</span>
          </span>
          <label class="input input-bordered flex items-center gap-2 bg-base-100">
            <input
              type="number"
              class="grow"
              min="0.1"
              max="24"
              step="0.1"
              value={props.minDurationHours()}
              title="Between 0.1 and 24 hours"
              onInput={(e) =>
                props.onDurationChange(
                  Math.max(0.1, parseFloat(e.currentTarget.value) || 0.1),
                )
              }
            />
            <span class="text-sm text-base-content/60">hours</span>
          </label>
        </label>
      </Show>

      <Show when={props.loopMode() === 'count'}>
        <label class="form-control">
          <span class="label py-1">
            <span class="label-text font-medium">Repeat count</span>
          </span>
          <input
            type="number"
            class="input input-bordered w-full bg-base-100"
            min="1"
            max="100"
            value={props.loopCount()}
            onInput={(e) =>
              props.onCountChange(
                Math.max(
                  1,
                  Math.min(100, parseInt(e.currentTarget.value) || 1),
                ),
              )
            }
          />
        </label>
      </Show>
    </CollapsibleSection>
  );
}
