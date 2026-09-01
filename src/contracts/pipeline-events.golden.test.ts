import { describe, expect, it } from 'vitest';
import goldenEvents from './pipeline-events.golden.json';
import type { PipelineEvent } from '../core/types';

const typedEvents = [
  {
    type: 'Progress',
    data: {
      total: 2,
      completed: 1,
      jobs: [
        {
          index: 0,
          state: 'done',
          progressPercent: 100,
          currentStep: 'Done',
          name: 'clip.mp4',
          outputPath: 'out/clip.mp4',
          thumbnailPath: 'thumb.jpg',
        },
        {
          index: 1,
          state: 'processing',
          progressPercent: 42,
          currentStep: 'Encoding',
          name: 'clip-2.mp4',
          outputPath: 'out/clip-2.mp4',
          thumbnailPath: null,
        },
      ],
    },
  },
  {
    type: 'Log',
    data: {
      level: 'info',
      message: 'Building master audio pool...',
    },
  },
  {
    type: 'Done',
    data: {
      completed: 2,
      total: 2,
      failed: 0,
    },
  },
  {
    type: 'Cancelled',
    data: 'Render cancelled by user',
  },
  {
    type: 'Paused',
  },
  {
    type: 'FatalError',
    data: 'No audio files selected or found',
  },
  {
    type: 'Stats',
    data: {
      speed: 1.25,
      bitrateKbps: 4123.4,
      fps: 29.97,
    },
  },
] satisfies readonly PipelineEvent[];

describe('PipelineEvent golden wire contract', () => {
  it('matches the typed frontend contract exactly', () => {
    expect(goldenEvents).toEqual(typedEvents);
  });

  it('covers every backend variant', () => {
    expect(new Set(typedEvents.map((event) => event.type))).toEqual(
      new Set([
        'Progress',
        'Log',
        'Done',
        'Cancelled',
        'Paused',
        'FatalError',
        'Stats',
      ]),
    );
  });

  it('uses camelCase field names at the IPC boundary', () => {
    const progress = typedEvents.find((event) => event.type === 'Progress');
    if (progress?.type !== 'Progress')
      throw new Error('Progress fixture missing');

    const job = progress.data.jobs[0];
    expect(job).toHaveProperty('progressPercent');
    expect(job).toHaveProperty('currentStep');
    expect(job).toHaveProperty('outputPath');
    expect(job).not.toHaveProperty('progress_percent');
  });
});
