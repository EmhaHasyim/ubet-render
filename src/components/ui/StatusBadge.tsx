import type { RenderJob } from '../../core/types';

/**
 * Soft, tinted status pill — a quiet tinted fill (no solid blocks) so the
 * palette stays calm while remaining scannable at a glance.
 */
const statusMap = {
  pending: {
    class: 'bg-base-300/50 text-base-content/60',
    label: 'Pending',
  },
  processing: {
    class: 'bg-info/10 text-info motion-safe:animate-pulse',
    label: 'Processing',
  },
  done: { class: 'bg-success/10 text-success', label: 'Done' },
  error: { class: 'bg-error/10 text-error', label: 'Error' },
} as const satisfies Record<
  RenderJob['state'],
  { class: string; label: string }
>;

export function StatusBadge(props: { state: RenderJob['state'] }) {
  return (
    <span
      class={`badge badge-sm border-none font-medium ${statusMap[props.state].class}`}
    >
      {statusMap[props.state].label}
    </span>
  );
}
