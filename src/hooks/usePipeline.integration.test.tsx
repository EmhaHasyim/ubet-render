/**
 * Integration test for the full render pipeline lifecycle via {@link usePipeline}.
 *
 * Unlike the unit tests in {@link usePipeline.test.tsx}, this test simulates
 * the complete flow: hardware detection, user setting paths, starting a render,
 * receiving events (Log, Progress, Stats, Done), and verifying that every
 * reactive signal updates correctly at each stage.
 *
 * All Tauri IPC calls are mocked so the test runs entirely in jsdom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@solidjs/testing-library';

// ---------------------------------------------------------------------------
// Mocks — must be at top level (vitest hoists vi.mock)
// ---------------------------------------------------------------------------
type InvokeFn = (cmd: string, args?: unknown) => Promise<unknown>;
let mockInvokeImpl: InvokeFn | null = null;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string, args?: unknown) =>
    mockInvokeImpl ? mockInvokeImpl(cmd, args) : Promise.resolve(undefined),
  ),
}));

type ListenCallback = (event: { payload: unknown }) => void;
const listenHandlers: Map<string, ListenCallback> = new Map();

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, cb: ListenCallback) => {
    listenHandlers.set(event, cb);
    return Promise.resolve(() => {
      listenHandlers.delete(event);
    });
  }),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
  })),
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(() => Promise.resolve(true)),
  requestPermission: vi.fn(() => Promise.resolve('granted')),
  sendNotification: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
import { usePipeline } from './usePipeline';

/** Syntactic sugar: fire a pipeline event as if the backend sent it. */
function emitEvent(payload: unknown) {
  const cb = listenHandlers.get('pipeline-event');
  if (!cb) throw new Error('No pipeline-event listener registered');
  cb({ payload });
}

/**
 * Mount the pipeline hook inside a rendered component so `onMount` fires.
 * Returns the hook's signal bag.
 */
function mountPipeline() {
  let result!: ReturnType<typeof usePipeline>;
  render(() => {
    result = usePipeline();
    return <div />;
  });
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('usePipeline — integration (end-to-end render lifecycle)', () => {
  beforeEach(() => {
    localStorage.clear();
    listenHandlers.clear();
    vi.clearAllMocks();

    // Default: hardware detection returns basic data.
    mockInvokeImpl = (cmd: string) => {
      if (cmd === 'detect_hardware') {
        return Promise.resolve({
          cpuName: 'AMD Ryzen 9',
          gpuName: 'NVIDIA RTX 4090',
          ramGb: 64,
          av1Supported: true,
        });
      }
      return Promise.resolve(undefined);
    };
  });

  it('boots in idle state with no jobs and no logs', () => {
    const p = mountPipeline();
    expect(p.running()).toBe(false);
    expect(p.paused()).toBe(false);
    expect(p.jobs()).toEqual([]);
    expect(p.logs()).toEqual([]);
    expect(p.liveStats()).toBeNull();
    expect(p.overallProgress()).toBe(0);
    expect(p.overallEta()).toBe('');
  });

  it('reflects default config values after mount', () => {
    const p = mountPipeline();

    expect(p.codec()).toBe('av1');
    expect(p.maxrate()).toBe('4000k');
    expect(p.outputFormat()).toBe('mp4');
    expect(p.audioMode()).toBe('original');
    expect(p.songsPerPlaylist()).toBe(9);
    expect(p.outputPath()).toBe('');
    expect(p.videoSource()).toBeNull();
    expect(p.audioSource()).toBeNull();
    expect(p.usePingpong()).toBe(true);
    expect(p.embedChapters()).toBe(true);
  });

  it('canStart returns false until all paths are set and hardware is detected', async () => {
    const p = mountPipeline();

    // Initially: no paths → canStart = false (hardware will resolve async)
    expect(p.canStart()).toBe(false);

    // Wait for hardware detection to complete
    await vi.waitFor(() => {
      expect(p.hardwareInfo()).not.toBeNull();
    });

    // Still false because paths aren't set
    expect(p.canStart()).toBe(false);

    // Set all paths
    p.setVideoSource({ type: 'files', paths: ['/v/test.mp4'] });
    p.setAudioSource({ type: 'files', paths: ['/a/test.mp3'] });
    p.setOutputPath('/out');

    expect(p.canStart()).toBe(true);
  });

  it('rejects start when maxrate is invalid', async () => {
    const p = mountPipeline();
    expect(p.maxrateValid()).toBe(true);

    // Set invalid bitrate
    p.setMaxrate('invalid');

    // Wait for effect to propagate
    await vi.waitFor(() => {
      expect(p.maxrateValid()).toBe(false);
    });

    // canStart should be false
    expect(p.canStart()).toBe(false);
  });

  it('full lifecycle: start → progress events → done', async () => {
    const p = mountPipeline();

    // Wait for hardware detection
    await vi.waitFor(() => {
      expect(p.hardwareInfo()).not.toBeNull();
    });

    // Set sources
    p.setVideoSource({ type: 'files', paths: ['/v/video.mp4'] });
    p.setAudioSource({ type: 'files', paths: ['/a/audio.mp3'] });
    p.setOutputPath('/out');
    expect(p.canStart()).toBe(true);

    // ---- Start render ----
    await p.startRender();

    // Verify start_render was invoked with correct parameters
    const { invoke } = await import('@tauri-apps/api/core');
    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
    const startRenderCall = invokeMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'start_render',
    );
    expect(startRenderCall).toBeTruthy();
    const [, params] = startRenderCall as [string, unknown];
    const { config, overrides } = params as {
      config: Record<string, unknown>;
      overrides: Record<string, unknown>;
    };
    expect(overrides.videoSource).toEqual({
      type: 'files',
      paths: ['/v/video.mp4'],
    });
    expect(overrides.audioSource).toEqual({
      type: 'files',
      paths: ['/a/audio.mp3'],
    });
    expect(overrides.outputPath).toBe('/out');
    expect(overrides.encoder).toBe('av1_nvenc');
    expect(config.metadata).toBeDefined();

    // Pipeline state: running = true
    expect(p.running()).toBe(true);
    expect(p.paused()).toBe(false);

    // ---- Simulate: Log event ----
    emitEvent({
      type: 'Log',
      data: { level: 'info', message: 'Starting render pipeline' },
    });

    expect(p.logs().length).toBeGreaterThan(0);
    expect(p.logs()[0]).toContain('Starting render pipeline');

    // ---- Simulate: Stats event ----
    emitEvent({
      type: 'Stats',
      data: { speed: 3.5, bitrateKbps: 4200, fps: 30 },
    });

    expect(p.liveStats()).not.toBeNull();
    expect(p.liveStats()?.speed).toBe(3.5);
    expect(p.liveStats()?.fps).toBe(30);

    // ---- Simulate: Progress event ----
    emitEvent({
      type: 'Progress',
      data: {
        total: 2,
        completed: 1,
        jobs: [
          {
            index: 0,
            name: 'intro.mp4',
            state: 'done',
            progressPercent: 100,
            currentStep: 'Muxing',
            outputPath: '/out/intro.mp4',
          },
          {
            index: 1,
            name: 'main.mp4',
            state: 'processing',
            progressPercent: 45,
            currentStep: 'Encoding',
            outputPath: '/out/main.mp4',
          },
        ],
      },
    });

    expect(p.jobs().length).toBe(2);
    expect(p.jobs()[0].name).toBe('intro.mp4');
    expect(p.jobs()[0].progressPercent).toBe(100);
    expect(p.jobs()[1].progressPercent).toBe(45);
    // Overall progress = (100 + 45) / 2 = 72.5
    expect(p.overallProgress()).toBeGreaterThan(70);
    expect(p.overallProgress()).toBeLessThan(75);

    // ETA should be calculated (since we have progress data)
    expect(p.overallEta()).toBeTruthy();

    // ---- Simulate: Done event ----
    emitEvent({
      type: 'Done',
      data: { completed: 2, total: 2, failed: 0 },
    });

    expect(p.running()).toBe(false);
    expect(p.overallProgress()).toBe(100);
    expect(p.overallEta()).toBe('Done');
  });

  it('handles error lifecycle: fatal error stops the pipeline', async () => {
    const p = mountPipeline();

    await vi.waitFor(() => {
      expect(p.hardwareInfo()).not.toBeNull();
    });

    p.setVideoSource({ type: 'files', paths: ['/v/vid.mp4'] });
    p.setAudioSource({ type: 'files', paths: ['/a/aud.mp3'] });
    p.setOutputPath('/out');

    await p.startRender();
    expect(p.running()).toBe(true);

    // Simulate fatal error
    emitEvent({
      type: 'FatalError',
      data: 'FFmpeg crashed: out of memory',
    });

    expect(p.running()).toBe(false);
    expect(p.overallEta()).toBe('Failed');
    expect(p.logs().some((l) => l.includes('FFmpeg crashed'))).toBe(true);
  });

  it('handles cancellation', async () => {
    const p = mountPipeline();

    await vi.waitFor(() => {
      expect(p.hardwareInfo()).not.toBeNull();
    });

    p.setVideoSource({ type: 'files', paths: ['/v/vid.mp4'] });
    p.setAudioSource({ type: 'files', paths: ['/a/aud.mp3'] });
    p.setOutputPath('/out');

    await p.startRender();
    expect(p.running()).toBe(true);

    emitEvent({
      type: 'Cancelled',
      data: 'User cancelled the render',
    });

    expect(p.running()).toBe(false);
    expect(p.paused()).toBe(false);
    expect(p.overallEta()).toBe('Render cancelled');
  });

  it('handles pause lifecycle', async () => {
    const p = mountPipeline();

    await vi.waitFor(() => {
      expect(p.hardwareInfo()).not.toBeNull();
    });

    p.setVideoSource({ type: 'files', paths: ['/v/vid.mp4'] });
    p.setAudioSource({ type: 'files', paths: ['/a/aud.mp3'] });
    p.setOutputPath('/out');

    await p.startRender();
    expect(p.running()).toBe(true);

    // Pause
    emitEvent({ type: 'Paused' });

    expect(p.running()).toBe(false);
    expect(p.paused()).toBe(true);
    expect(p.overallEta()).toBe('Paused');

    // Listener should STILL be alive (to allow resume/cancel/fatal)
    expect(listenHandlers.has('pipeline-event')).toBe(true);
  });

  it('can set and read all persisted config fields', () => {
    const p = mountPipeline();

    p.setCodec('h265');
    p.setMaxrate('8000k');
    p.setAudioMode('normalize');
    p.setOutputFormat('mkv');
    p.setOutputPrefix('My Channel');
    p.setSongsPerPlaylist(15);
    p.setMinDurationHours(2.5);
    p.setLoopMode('count');
    p.setLoopCount(5);
    p.setUsePingpong(false);
    p.setEmbedChapters(false);

    expect(p.codec()).toBe('h265');
    expect(p.maxrate()).toBe('8000k');
    expect(p.audioMode()).toBe('normalize');
    expect(p.outputFormat()).toBe('mkv');
    expect(p.outputPrefix()).toBe('My Channel');
    expect(p.songsPerPlaylist()).toBe(15);
    expect(p.minDurationHours()).toBe(2.5);
    expect(p.loopMode()).toBe('count');
    expect(p.loopCount()).toBe(5);
    expect(p.usePingpong()).toBe(false);
    expect(p.embedChapters()).toBe(false);
  });
});
