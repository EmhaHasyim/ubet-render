import { render, screen } from '@solidjs/testing-library';
import { describe, it, expect } from 'vitest';
import type { JobProgress } from '../../core/types';
import { StatsStrip } from './StatsStrip';
import { WithPipeline } from '../test-utils';

const sampleJobs: JobProgress[] = [
  {
    index: 0,
    name: 'intro.mp4',
    outputPath: '/out/intro.mp4',
    state: 'done',
    progressPercent: 100,
    currentStep: 'Muxing',
    thumbnailPath: null,
  },
  {
    index: 1,
    name: 'loop.mp4',
    outputPath: '/out/loop.mp4',
    state: 'processing',
    progressPercent: 55,
    currentStep: 'Encoding',
    thumbnailPath: null,
  },
  {
    index: 2,
    name: 'outro.mp4',
    outputPath: '/out/outro.mp4',
    state: 'pending',
    progressPercent: 0,
    currentStep: 'Queued',
    thumbnailPath: null,
  },
  {
    index: 3,
    name: 'fail.mp4',
    outputPath: '/out/fail.mp4',
    state: 'error',
    progressPercent: 12,
    currentStep: 'Error',
    thumbnailPath: null,
  },
];

describe('StatsStrip', () => {
  it('shows placeholder stats strip when there are no jobs and no live stats', () => {
    const { container } = render(() => (
      <WithPipeline>
        <StatsStrip />
      </WithPipeline>
    ));
    expect(container.querySelector('.stats')).toBeTruthy();
    expect(
      screen.getByText('Configure your sources and start a render'),
    ).toBeTruthy();
    expect(screen.getByText('Idle')).toBeTruthy();
  });

  it('shows total, done, failed, processing counts', () => {
    render(() => (
      <WithPipeline overrides={{ jobs: () => sampleJobs }}>
        <StatsStrip />
      </WithPipeline>
    ));

    // Total = 4
    expect(screen.getByText('4')).toBeTruthy();
    // 1 processing + 1 queued
    expect(screen.getByText('1 processing · 1 queued')).toBeTruthy();
    // Done count
    expect(screen.getByText('jobs done')).toBeTruthy();
    // Failed count
    expect(screen.getByText('needs attention')).toBeTruthy();
  });

  it('shows progress percentage', () => {
    render(() => (
      <WithPipeline
        overrides={{
          jobs: () => sampleJobs,
          overallProgress: () => 42,
        }}
      >
        <StatsStrip />
      </WithPipeline>
    ));
    expect(screen.getByText('42%')).toBeTruthy();
  });

  it('shows Preparing... when ETA is empty', () => {
    render(() => (
      <WithPipeline overrides={{ jobs: () => sampleJobs }}>
        <StatsStrip />
      </WithPipeline>
    ));
    expect(screen.getByText('Preparing...')).toBeTruthy();
  });

  it('shows custom ETA when provided', () => {
    render(() => (
      <WithPipeline
        overrides={{
          jobs: () => sampleJobs,
          overallEta: () => '2m 34s',
        }}
      >
        <StatsStrip />
      </WithPipeline>
    ));
    expect(screen.getByText('2m 34s')).toBeTruthy();
  });

  it('shows live stats with speed, fps, and bitrate', () => {
    render(() => (
      <WithPipeline
        overrides={{
          liveStats: () => ({
            speed: 12.5,
            bitrateKbps: 8500,
            fps: 60,
          }),
        }}
      >
        <StatsStrip />
      </WithPipeline>
    ));
    expect(screen.getByText('12.5x')).toBeTruthy();
    expect(screen.getByText('60 fps · 8.5 Mbps')).toBeTruthy();
  });

  it('shows Idle when live stats is null', () => {
    render(() => (
      <WithPipeline
        overrides={{
          jobs: () => sampleJobs,
        }}
      >
        <StatsStrip />
      </WithPipeline>
    ));
    expect(screen.getByText('Idle')).toBeTruthy();
  });
});
