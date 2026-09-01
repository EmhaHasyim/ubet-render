/**
 * Reusable skeleton loading placeholder.
 *
 * Renders an animated shimmer block that mirrors the dimensions of the
 * eventual content, reducing perceived loading time and layout shift.
 *
 * Usage:
 * ```tsx
 * <Skeleton class="h-4 w-48" />              // text line
 * <Skeleton variant="circle" class="h-10 w-10" /> // avatar
 * <Skeleton variant="rect" class="h-24 w-full" />  // card / panel
 * ```
 */

interface SkeletonProps {
  /** Additional CSS classes for sizing, spacing, etc. */
  class?: string;
  /**
   * Shape variant:
   * - `'text'`   (default) — rounded square, suitable for text lines
   * - `'circle'` — fully rounded, suitable for icons / avatars
   * - `'rect'`   — sharp corners, suitable for images / panels
   */
  variant?: 'text' | 'circle' | 'rect';
  /**
   * Screen-reader label.  Defaults to empty (hidden).  Set on the *outermost*
   * skeleton container only — child skeletons should stay silent to avoid
   * repeating "Loading..." for every row.
   */
  label?: string;
}

const radiusClass: Record<'text' | 'circle' | 'rect', string> = {
  text: 'rounded-md',
  circle: 'rounded-full',
  rect: 'rounded-lg',
};

export function Skeleton(props: SkeletonProps) {
  return (
    <div
      class={`skeleton-shimmer ${radiusClass[props.variant ?? 'text']} ${props.class ?? ''}`}
      aria-hidden={!props.label}
      {...(props.label ? { role: 'status', 'aria-label': props.label } : {})}
    />
  );
}
