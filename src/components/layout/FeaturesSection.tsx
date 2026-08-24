import { CollapsibleSection } from './CollapsibleSection';
import type { Accessor } from 'solid-js';

/**
 * Feature toggles: ping-pong, embed chapters, skip re-encode.
 * Content for the "Features" collapsible section.
 */
export function FeaturesSection(props: {
  usePingpong: Accessor<boolean>;
  embedChapters: Accessor<boolean>;
  skipIntermediateOnCodecMatch: Accessor<boolean>;
  onPingpongChange: (v: boolean) => void;
  onChaptersChange: (v: boolean) => void;
  onSkipReencodeChange: (v: boolean) => void;
}) {
  return (
    <CollapsibleSection icon="lucide:sparkles" title="Features">
      <label class="flex min-h-20 items-center justify-between gap-4 rounded-lg border border-base-300 bg-base-100 px-4 py-3">
        <span>
          <span class="block text-sm font-medium">Ping-pong effect</span>
          <span class="block text-xs text-base-content/60">Mirrored loop</span>
        </span>
        <input
          type="checkbox"
          class="toggle toggle-primary"
          checked={props.usePingpong()}
          onChange={(e) => props.onPingpongChange(e.currentTarget.checked)}
        />
      </label>

      <label class="flex min-h-20 items-center justify-between gap-4 rounded-lg border border-base-300 bg-base-100 px-4 py-3">
        <span>
          <span class="block text-sm font-medium">Embed chapters</span>
          <span class="block text-xs text-base-content/60">
            Native MP4/MKV chapters
          </span>
        </span>
        <input
          type="checkbox"
          class="toggle toggle-primary"
          checked={props.embedChapters()}
          onChange={(e) => props.onChaptersChange(e.currentTarget.checked)}
        />
      </label>

      <label
        class="flex min-h-20 items-center justify-between gap-4 rounded-lg border border-base-300 bg-base-100 px-4 py-3"
        data-testid="zero-reencode-toggle"
        title="When ON, the intermediate re-encode step is bypassed entirely and the source video is stream-copied directly. The output codec is determined by the source file — no codec matching check is performed. Disables ping-pong processing."
      >
        <span>
          <span class="inline-flex items-center gap-2 text-sm font-medium">
            Skip re-encode (direct stream copy)
            <span class="badge badge-xs badge-outline text-[0.625rem]">
              ADVANCED
            </span>
          </span>
          <span class="block text-xs text-base-content/60">
            Bypass the intermediate re-encode and use the source video as-is.
            The output codec will follow the source file; ping-pong is
            unavailable in this mode.
          </span>
        </span>
        <input
          type="checkbox"
          class="toggle toggle-primary"
          checked={props.skipIntermediateOnCodecMatch()}
          onChange={(e) => props.onSkipReencodeChange(e.currentTarget.checked)}
          aria-label="Skip re-encode (direct stream copy)"
        />
      </label>
    </CollapsibleSection>
  );
}
