import { render, screen, fireEvent } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
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
    thumbnailPath: null,
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
    thumbnailPath: null,
  },
  {
    index: 3,
    name: 'error.mp4',
    outputPath: '/out/error.mp4',
    state: 'error',
    progressPercent: 12,
    currentStep: 'FFmpeg crash',
    thumbnailPath: null,
  },
];

describe('JobTable', () => {
  it('shows empty state when jobs array is empty', () => {
    render(() => <JobTable jobs={[]} />);
    expect(screen.getByText('No jobs yet')).toBeTruthy();
    expect(
      screen.getByText(/Start a render from the Render tab/i),
    ).toBeTruthy();
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
    render(() => <JobTable jobs={[sampleJobs[1]!]} />);
    const bar = screen.getByRole('progressbar', { name: /loop.mp4 progress/i });
    expect(bar).toBeTruthy();
    expect((bar as HTMLProgressElement).value).toBe(55);
    expect((bar as HTMLProgressElement).max).toBe(100);
  });

  it('shows file-video placeholder when thumbnailPath is null', () => {
    const { container } = render(() => <JobTable jobs={[sampleJobs[0]!]} />);
    // sampleJobs[0] has a null thumbnailPath → shows placeholder
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBe(0);
  });

  it('renders an img when thumbnailPath exists', () => {
    const { container } = render(() => <JobTable jobs={[sampleJobs[1]!]} />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toContain('asset://localhost/');
  });

  it('keeps the placeholder after a thumbnail fails to load, even across jobs updates', () => {
    // Regression for the per-row createSignal bug: each Progress event replaces
    // the jobs array with fresh item objects, which used to recreate the row's
    // error signal and flip a failed thumbnail back to the broken <img>.
    const withThumb: JobProgress[] = [
      {
        index: 0,
        name: 'a.mp4',
        outputPath: '/out/a.mp4',
        state: 'processing',
        progressPercent: 10,
        currentStep: 'Encoding',
        thumbnailPath: '/thumbs/a.jpg',
      },
    ];
    const [jobs, setJobs] = createSignal<JobProgress[]>(withThumb);
    const { container } = render(() => <JobTable jobs={jobs()} />);

    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();
    fireEvent.error(img);

    // Simulate the next Progress event: a brand-new jobs array (new object
    // identity) carrying the same thumbnail path.
    setJobs([{ ...withThumb[0]!, progressPercent: 20 }]);

    // The broken image must stay replaced by the placeholder icon.
    expect(container.querySelectorAll('img').length).toBe(0);
    expect(container.querySelector('.bg-base-300')).toBeTruthy();
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
