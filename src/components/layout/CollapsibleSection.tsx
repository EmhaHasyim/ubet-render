import { createSignal, type JSX } from 'solid-js';
import { Icon } from '@iconify-icon/solid';

/** Shared collapse-title classes for consistent section headers. */
const collapseTitleClass =
  'text-sm font-semibold uppercase tracking-wider text-base-content/60 flex items-center gap-2';

/** Shared collapse-content grid matching the outer grid columns. */
const collapseContentGrid =
  'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 pt-1';

/**
 * Reusable DaisyUI collapse section wrapper used by all render-option
 * sections (Audio, Video & Encoding, Looping, Features).
 *
 * Starts expanded by default (consistent with the pre-0.2.7
 * `checked`-hardcoded behaviour). The user can toggle any section
 * closed by clicking its title bar.
 *
 * Extracted from {@link SettingsCard} to eliminate 4× duplicated collapse
 * boilerplate.
 */
export function CollapsibleSection(props: {
  icon: string;
  title: string;
  children: JSX.Element;
}) {
  // Expand by default — preserves the historical always-open UX that
  // every existing consumer implicitly depends on.
  const [expanded, setExpanded] = createSignal(true);

  return (
    <div class="col-span-full collapse collapse-arrow bg-base-100 rounded-lg border border-base-300">
      <input
        type="checkbox"
        checked={expanded()}
        onChange={(e) => setExpanded(e.currentTarget.checked)}
        aria-label={`Toggle ${props.title} section`}
      />
      <div class={collapseTitleClass}>
        <Icon icon={props.icon} width="14" height="14" />
        {props.title}
      </div>
      <div class={collapseContentGrid}>{props.children}</div>
    </div>
  );
}
