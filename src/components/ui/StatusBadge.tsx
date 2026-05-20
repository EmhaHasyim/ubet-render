import type { RenderJob } from '../../core/types';

const statusMap: Record<RenderJob['state'], { class: string; label: string }> = {
  pending: { class: 'badge-ghost', label: 'Pending' },
  processing: { class: 'badge-info animate-pulse shadow-[0_0_8px_rgba(56,189,248,0.5)]', label: 'Processing' },
  done: { class: 'badge-success', label: 'Done' },
  error: { class: 'badge-error', label: 'Error' },
};

export function StatusBadge(props: { state: RenderJob['state'] }) {
  return (
    <span class={`badge badge-sm font-medium border-none ${statusMap[props.state].class} ${props.state === 'processing' ? 'text-info-content' : ''}`}>
      {statusMap[props.state].label}
    </span>
  );
}