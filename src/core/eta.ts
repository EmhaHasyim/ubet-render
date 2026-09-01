import { formatDuration } from './estimate';

export class EtaCalculator {
  /** Exponential moving average of the rate (% gained per ms). */
  private emaRate = 0;

  // Alpha tuned so recent samples dominate after ~3-4 data points while
  // retaining smoothness.  De-tuned from the standard 0.2 to 0.35 because
  // progress updates arrive every ~120 ms (throttled), so reactivity matters
  // more than noise rejection.
  private readonly alpha = 0.35;

  constructor(_capacity: number) {
    // Keep the historical constructor parameter for API compatibility. The
    // current EMA does not need a sample buffer, so intentionally consume it.
    void _capacity;
  }

  reset() {
    this.emaRate = 0;
  }

  addSample(elapsedMs: number, progressGained: number) {
    // Update the EMA with the instantaneous rate of this sample so the
    // ETA reacts quickly to stalls (sudden rate drop) while still smoothing
    // noise from individual ffmpeg progress lines.
    if (elapsedMs > 0) {
      const instantRate = progressGained / elapsedMs;
      if (this.emaRate === 0) {
        this.emaRate = instantRate;
      } else {
        this.emaRate =
          this.alpha * instantRate + (1 - this.alpha) * this.emaRate;
      }
    }
  }

  estimateRemaining(currentPercent: number): string {
    if (currentPercent >= 100) return 'Done';
    if (this.emaRate <= 0) return 'Calculating...';

    const remainingMs = (100 - currentPercent) / this.emaRate;
    // The 7-day upper bound only guards against absurd extrapolations from a
    // single early sample. The previous 24 h cap was too aggressive: renders
    // can legitimately run up to 24 h (minDurationHours max), so the ETA
    // would show "Calculating..." for almost the entire render.
    if (remainingMs > 0 && remainingMs < 604800000) {
      return formatDuration(remainingMs);
    }
    return 'Calculating...';
  }
}
