export function OverallProgress(props: { value: number; eta?: string }) {
  const safeValue = () => Math.min(100, Math.max(0, Number.isFinite(props.value) ? props.value : 0));

  return (
    <section class="panel p-4">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 class="font-semibold">Batch progress</h3>
          <p class="text-sm text-base-content/60">{props.eta || 'Preparing...'}</p>
        </div>
        <span class="font-mono text-xl font-semibold">{Math.round(safeValue())}%</span>
      </div>
      <progress class="progress progress-primary h-3 w-full" value={safeValue()} max="100" />
    </section>
  );
}
