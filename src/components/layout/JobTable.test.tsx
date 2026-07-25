import { render, screen } from '@solidjs/testing-library';
import { describe, it, expect, vi } from 'vitest';
import type { JobProgress } from '../../core/types';
import { JobTable } from './JobTable';

// Mock Tauri APIs that aren't available in jsdom
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
  invoke: vi.fn(),
}));

const sampleJobs: JobProgress[] = [
  {
    index: 0,
    name: 'intro.mp4',
    outputPath: '/out/intro.mp4',
    state: 'done',
    progressPercent: 100,
    currentStep: 'Muxing',
  },
  {
    index: 1,
    name: 'loop.mp4',
    outputPath: '/out/loop.mp4',
    state: 'processing',
    progressPercent: 55,
    currentStep: 'Encoding',
    thumbnailPath: '/thumbs/loop_thumb.jpg',
  },
  {
    index: 2,
    name: 'outro.mp4',
    outputPath: '/out/outro.mp4',
    state: 'pending',
    progressPercent: 0,
    currentStep: 'Queued',
  },
  {
    index: 3,
    name: 'error.mp4',
    outputPath: '/out/error.mp4',
    state: 'error',
    progressPercent: 12,
    currentStep: 'FFmpeg crash',
  },
];

describe('JobTable', () => {
  it('shows empty state when jobs array is empty', () => {
    render(() => <JobTable jobs={[]} />);
    expect(screen.getByText('No jobs yet')).toBeTruthy();
    expect(screen.getByText(/Queue is empty/i)).toBeTruthy();
  });

  it('renders job rows for each job', () => {
    render(() => <JobTable jobs={sampleJobs} />);
    expect(screen.getByText('intro.mp4')).toBeTruthy();
    expect(screen.getByText('loop.mp4')).toBeTruthy();
    expect(screen.getByText('outro.mp4')).toBeTruthy();
    expect(screen.getByText('error.mp4')).toBeTruthy();
  });

  it('shows progress percentage per job', () => {
    render(() => <JobTable jobs={sampleJobs} />);
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByText('55%')).toBeTruthy();
    expect(screen.getByText('0%')).toBeTruthy();
    expect(screen.getByText('12%')).toBeTruthy();
  });

  it('shows current step description', () => {
    render(() => <JobTable jobs={sampleJobs} />);
    expect(screen.getByText('Muxing')).toBeTruthy();
    expect(screen.getByText('Encoding')).toBeTruthy();
    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.getByText('FFmpeg crash')).toBeTruthy();
  });

  it('renders progress element with aria attributes', () => {
    render(() => <JobTable jobs={[sampleJobs[1]]} />);
    const bar = screen.getByRole('progressbar', { name: /loop.mp4 progress/i });
    expect(bar).toBeTruthy();
    expect((bar as HTMLProgressElement).value).toBe(55);
    expect((bar as HTMLProgressElement).max).toBe(100);
  });

  it('shows file-video placeholder when thumbnailPath is undefined', () => {
    const { container } = render(() => <JobTable jobs={[sampleJobs[0]]} />);
    // sampleJobs[0] has no thumbnailPath → shows placeholder
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBe(0);
  });

  it('renders an img when thumbnailPath exists', () => {
    const { container } = render(() => <JobTable jobs={[sampleJobs[1]]} />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toContain('asset://localhost/');
  });

  it('reveal button is enabled for done jobs and disabled for others', () => {
    render(() => <JobTable jobs={sampleJobs} />);
    const buttons = screen.getAllByTitle('Reveal in folder');
    // First job is done → button enabled
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    // Second job is processing → button disabled
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[2] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[3] as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders table header columns', () => {
    render(() => <JobTable jobs={sampleJobs} />);
    expect(screen.getByText('Video')).toBeTruthy();
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('Step')).toBeTruthy();
    expect(screen.getByText('Progress')).toBeTruthy();
    expect(screen.getByText('Actions')).toBeTruthy();
  });
});
