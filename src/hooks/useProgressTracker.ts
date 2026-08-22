import { createSignal, type Accessor, type Setter } from 'solid-js';
import type { PipelineStats } from '../core/types';
import { EtaCalculator } from '../core/eta';

const MAX_ETA_SAMPLES = 10;

/**
 * Self-contained progress and ETA tracking for the render pipeline.
 *
 * Extracted from {@link usePipeline} so the progress signals, baseline
 * state, and ETA calculator live together instead of being scattered
 * across the orchestrator hook.
 */
export interface ProgressTracker {
  overallProgress: Accessor<number>;
  setOverallProgress: Setter<number>;
  overallEta: Accessor<string>;
  setOverallEta: Setter<string>;
  liveStats: Accessor<PipelineStats | null>;
  setLiveStats: Setter<PipelineStats | null>;

  /** Internal: baseline progress for ETA calculation. */
  getStartProgress: () => number;
  /** Internal: update baseline progress. */
  setStartProgress: (value: number) => void;
  /** Internal: wall-clock start for ETA calculation. */
  getStartTime: () => number;
  /** Internal: EMA-based ETA calculator instance. */
  etaCalculator: EtaCalculator;

  /** Reset progress signals before a new (or resumed) render starts. */
  resetProgress: (resuming: boolean) => void;
  /** Re-seed the ETA baseline after a pause→resume transition. */
  seedResumeBaseline: () => void;
}

export function useProgressTracker(): ProgressTracker {
  const [overallProgress, setOverallProgress] = createSignal(0);
  const [overallEta, setOverallEta] = createSignal('');
  const [liveStats, setLiveStats] = createSignal<PipelineStats | null>(null);

  let startProgress = 0;
  let startTime = 0;
  const etaCalculator = new EtaCalculator(MAX_ETA_SAMPLES);

  /**
   * Fresh ETA baseline for a resumed render. The backend resumes from the
   * *saved* state file, whose progress can differ from the last value the UI
   * saw (state is saved every ~2s while progress events are throttled to
   * 120ms). A stale baseline would make the first post-resume Progress event
   * look like a huge burst of work (bogus near-zero ETA), and the pause idle
   * time must not count as render time. Seed a sentinel so the first
   * post-resume Progress event establishes the real baseline before any
   * sample is taken.
   */
  const seedResumeBaseline = () => {
    startProgress = -1;
    startTime = Date.now();
    etaCalculator.reset();
  };

  const resetProgress = (resuming: boolean) => {
    setOverallProgress(0);
    setLiveStats(null);
    if (!resuming) {
      setOverallEta('Calculating...');
      startProgress = 0;
      etaCalculator.reset();
    } else {
      setOverallEta('Resuming...');
      seedResumeBaseline();
    }
    startTime = Date.now();
  };

  return {
    overallProgress,
    setOverallProgress,
    overallEta,
    setOverallEta,
    liveStats,
    setLiveStats,
    getStartProgress: () => startProgress,
    setStartProgress: (value: number) => {
      startProgress = value;
    },
    getStartTime: () => startTime,
    etaCalculator,
    resetProgress,
    seedResumeBaseline,
  };
}
