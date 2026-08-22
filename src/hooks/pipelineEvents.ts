import type { Setter } from 'solid-js';
import type {
  JobProgress,
  PipelineDone,
  PipelineEvent,
  PipelineProgress,
  PipelineStats,
} from '../core/types';
import { EtaCalculator } from '../core/eta';
import { notify } from '../core/notify';
import { showToast } from '../core/toast';

export interface PipelineEventRuntime {
  cancelPauseReconcile: () => void;
  appendLog: (line: string) => void;
  safeUnlisten: () => void;

  setRunning: Setter<boolean>;
  setPaused: Setter<boolean>;
  setJobs: Setter<JobProgress[]>;
  setOverallProgress: Setter<number>;
  setOverallEta: Setter<string>;
  setLiveStats: Setter<PipelineStats | null>;

  getStartProgress: () => number;
  setStartProgress: (value: number) => void;
  getStartTime: () => number;
  etaCalculator: EtaCalculator;
}

/**
 * Create the state transitions for events emitted by the Rust pipeline.
 *
 * The hook owns lifecycle resources such as the Tauri listener and timers;
 * this module owns only event-to-state behavior and user-facing outcomes.
 */
export function createPipelineEventHandler(
  runtime: PipelineEventRuntime,
): (event: PipelineEvent) => void {
  const handleProgress = (data: PipelineProgress) => {
    runtime.setJobs(data.jobs);

    const jobsProgressSum = data.jobs.reduce(
      (sum, job) => sum + job.progressPercent,
      0,
    );
    const overallPercent =
      data.total > 0
        ? Math.min(100, Math.max(0, jobsProgressSum / data.total))
        : 0;
    runtime.setOverallProgress(overallPercent);

    const startProgress = runtime.getStartProgress();
    if (startProgress < 0) {
      runtime.setStartProgress(overallPercent);
      if (overallPercent >= 100) runtime.setOverallEta('Done');
      return;
    }

    const progressGained = overallPercent - startProgress;
    if (progressGained > 0.001 && overallPercent < 100) {
      const elapsedMs = Date.now() - runtime.getStartTime();
      runtime.etaCalculator.addSample(elapsedMs, progressGained);
      runtime.setOverallEta(
        runtime.etaCalculator.estimateRemaining(overallPercent),
      );
    } else if (overallPercent >= 100) {
      runtime.setOverallEta('Done');
    }
  };

  const handleDone = (data: PipelineDone) => {
    runtime.setRunning(false);
    runtime.setPaused(false);
    runtime.setOverallProgress(100);
    runtime.setOverallEta(data.failed > 0 ? 'Finished with errors' : 'Done');
    runtime.safeUnlisten();
    void notify(
      data.failed > 0 ? 'Render finished with errors' : 'Render finished',
      `${data.completed}/${data.total} done, ${data.failed} failed.`,
    );
    showToast(
      data.failed > 0
        ? `Render finished with ${data.failed} error${data.failed === 1 ? '' : 's'}`
        : 'Render finished',
      {
        variant: data.failed > 0 ? 'warning' : 'success',
        ttl: 4500,
      },
    );
  };

  const handlePaused = () => {
    runtime.cancelPauseReconcile();
    runtime.appendLog('[INFO] Render paused');
    runtime.setRunning(false);
    runtime.setPaused(true);
    runtime.setOverallEta('Paused');
    showToast('Render paused', { variant: 'info', ttl: 2500 });
  };

  const handleCancelled = (message: string) => {
    runtime.appendLog(`[INFO] ${message}`);
    runtime.setRunning(false);
    runtime.setPaused(false);
    runtime.setOverallEta('Render cancelled');
    runtime.safeUnlisten();
  };

  const handleFatalError = (message: string) => {
    runtime.appendLog(`FATAL: ${message}`);
    runtime.setRunning(false);
    runtime.setPaused(false);
    runtime.setOverallEta('Failed');
    runtime.safeUnlisten();
    void notify('Render failed', `Error: ${message}`);
    showToast(`Render failed: ${message}`, { variant: 'error', ttl: 0 });
  };

  return (event: PipelineEvent) => {
    switch (event.type) {
      case 'Log':
        runtime.appendLog(
          `[${event.data.level.toUpperCase()}] ${event.data.message}`,
        );
        break;
      case 'Stats':
        runtime.setLiveStats(event.data);
        break;
      case 'Progress':
        handleProgress(event.data);
        break;
      case 'Done':
        handleDone(event.data);
        break;
      case 'Paused':
        handlePaused();
        break;
      case 'Cancelled':
        handleCancelled(event.data);
        break;
      case 'FatalError':
        handleFatalError(event.data);
        break;
    }
  };
}
