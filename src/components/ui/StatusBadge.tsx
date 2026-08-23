import type { RenderJob } from '../../core/types';

const statusMap = {
  pending: { class: 'badge-ghost', label: 'Pending' },
  processing: {
    class:
      'badge-info motion-safe:animate-pulse shadow-[0_0_8px_color-mix(in_oklch,var(--color-info)_50%,transparent)]',
    label: 'Processing',
  },
  done: { class: 'badge-success', label: 'Done' },
  error: { class: 'badge-error', label: 'Error' },
} as const satisfies Record<
  RenderJob['state'],
  { class: string; label: string }
>;

export function StatusBadge(props: { state: RenderJob['state'] }) {
  return (
    <span
      class={`badge badge-sm font-medium border-none ${statusMap[props.state].class} ${props.state === 'processing' ? 'text-info-content' : ''}`}
    >
      {statusMap[props.state].label}
    </span>
  );
}
