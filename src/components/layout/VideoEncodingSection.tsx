import { Show } from 'solid-js';
import { CollapsibleSection } from './CollapsibleSection';
import type { Accessor } from 'solid-js';

/**
 * Video & Encoding settings: codec, max bitrate, output format, output prefix.
 * Content for the "Video & Encoding" collapsible section.
 */
export function VideoEncodingSection(props: {
  codec: Accessor<string>;
  av1Supported: Accessor<boolean>;
  maxrate: Accessor<string>;
  maxrateValid: Accessor<boolean>;
  outputFormat: Accessor<'mp4' | 'mkv'>;
  outputPrefix: Accessor<string>;
  onCodecChange: (v: string) => void;
  onMaxrateChange: (v: string) => void;
  onMaxrateBlur: (raw: string) => void;
  onFormatChange: (v: 'mp4' | 'mkv') => void;
  onPrefixChange: (v: string) => void;
}) {
  return (
    <CollapsibleSection icon="lucide:monitor" title="Video & Encoding">
      <label class="form-control">
        <span class="label py-1">
          <span class="label-text font-medium">Video codec</span>
        </span>
        <select
          class="select select-bordered w-full bg-base-100"
          value={props.codec()}
          onChange={(e) => props.onCodecChange(e.currentTarget.value)}
        >
          <option value="h264">H.264</option>
          <option value="h265">H.265</option>
          <option value="av1" disabled={!props.av1Supported()}>
            AV1 {!props.av1Supported() ? '(unsupported)' : ''}
          </option>
        </select>
      </label>

      <label class="form-control">
        <span class="label py-1">
          <span class="label-text font-medium">Max bitrate</span>
        </span>
        <input
          type="text"
          inputmode="numeric"
          class={`input input-bordered w-full bg-base-100 ${!props.maxrateValid() ? 'input-error' : ''}`}
          placeholder="5000"
          value={props.maxrate()}
          onInput={(e) => props.onMaxrateChange(e.currentTarget.value)}
          onBlur={(e) => props.onMaxrateBlur(e.currentTarget.value)}
          aria-invalid={!props.maxrateValid()}
        />
        <Show when={!props.maxrateValid()}>
          <span class="mt-1 text-xs text-error">
            Enter a number between 100 and 50000 (e.g. 5000).
          </span>
        </Show>
      </label>

      <div class="fieldset p-0">
        <span class="fieldset-legend">Output format</span>
        <div class="join w-full">
          <input
            type="radio"
            class="btn join-item btn-outline flex-1"
            name="outputFormat"
            value="mp4"
            checked={props.outputFormat() === 'mp4'}
            onChange={() => props.onFormatChange('mp4')}
            aria-label="MP4"
          />
          <input
            type="radio"
            class="btn join-item btn-outline flex-1"
            name="outputFormat"
            value="mkv"
            checked={props.outputFormat() === 'mkv'}
            onChange={() => props.onFormatChange('mkv')}
            aria-label="MKV"
          />
        </div>
        <span class="fieldset-label">
          MP4 for widest compatibility; MKV for AV1 and best player support.
        </span>
      </div>

      <label class="form-control">
        <span class="label py-1">
          <span class="label-text font-medium">Output prefix</span>
        </span>
        <input
          type="text"
          class="input input-bordered w-full bg-base-100"
          placeholder="Ubet Render"
          value={props.outputPrefix()}
          onInput={(e) => props.onPrefixChange(e.currentTarget.value)}
        />
      </label>
    </CollapsibleSection>
  );
}
