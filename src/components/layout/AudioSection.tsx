import { CollapsibleSection } from './CollapsibleSection';
import type { Accessor } from 'solid-js';

/**
 * Audio settings: songs-per-video and audio mode (original / normalize).
 * Content for the "Audio" collapsible section.
 */
export function AudioSection(props: {
  songsPerPlaylist: Accessor<number>;
  audioMode: Accessor<'original' | 'normalize'>;
  onSongsChange: (v: number) => void;
  onModeChange: (v: 'original' | 'normalize') => void;
}) {
  return (
    <CollapsibleSection step={2} title="Audio">
      <label class="form-control">
        <span class="label py-1">
          <span class="label-text font-medium">Songs per video</span>
        </span>
        <input
          type="number"
          class="input input-bordered w-full bg-base-100"
          min="1"
          max="100"
          value={props.songsPerPlaylist()}
          onInput={(e) =>
            props.onSongsChange(
              Math.max(1, parseInt(e.currentTarget.value) || 1),
            )
          }
        />
      </label>

      <div class="fieldset p-0">
        <span class="fieldset-legend">Audio mode</span>
        <div class="join w-full">
          <input
            type="radio"
            class="btn join-item btn-outline flex-1"
            name="audioMode"
            value="original"
            checked={props.audioMode() === 'original'}
            onChange={() => props.onModeChange('original')}
            aria-label="Original"
          />
          <input
            type="radio"
            class="btn join-item btn-outline flex-1"
            name="audioMode"
            value="normalize"
            checked={props.audioMode() === 'normalize'}
            onChange={() => props.onModeChange('normalize')}
            aria-label="Normalize"
          />
        </div>
        <span class="fieldset-label">
          Original keeps audio faithful; Normalize applies YouTube Music
          loudness.
        </span>
      </div>
    </CollapsibleSection>
  );
}
