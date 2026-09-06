// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONFIG,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  LOUDNORM_PARAMS,
  getSourcePaths,
} from './config';

describe('DEFAULT_CONFIG', () => {
  it('has expected directory defaults', () => {
    expect(DEFAULT_CONFIG.directories.video).toBe('./videos');
    expect(DEFAULT_CONFIG.directories.audio).toBe('./audios');
    expect(DEFAULT_CONFIG.directories.output).toBe('./outputs');
    expect(DEFAULT_CONFIG.directories.cache).toBe('./cache');
  });

  it('has expected metadata defaults', () => {
    expect(DEFAULT_CONFIG.metadata.channelPrefix).toBe('Ubet Render');
  });

  it('has expected target defaults', () => {
    expect(DEFAULT_CONFIG.target.minDurationSec).toBe(3600);
    expect(DEFAULT_CONFIG.target.paddingSec).toBe(10);
  });

  it('has expected video defaults', () => {
    expect(DEFAULT_CONFIG.video.bitrateTarget).toBe('4000k');
    expect(DEFAULT_CONFIG.video.bitrateMax).toBe('5000k');
    expect(DEFAULT_CONFIG.video.encoder).toBe('av1_nvenc');
    expect(DEFAULT_CONFIG.video.preset).toBe('p6');
  });

  it('has expected audio defaults', () => {
    expect(DEFAULT_CONFIG.audio.songsPerPlaylist).toBe(9);
    expect(DEFAULT_CONFIG.audio.concurrentPrep).toBe(5);
    expect(DEFAULT_CONFIG.audio.bitrate).toBe('192k');
    expect(DEFAULT_CONFIG.audio.sampleRate).toBe(44100);
    expect(DEFAULT_CONFIG.audio.loudnormParams).toBe(LOUDNORM_PARAMS);
    expect(DEFAULT_CONFIG.audio.audioMode).toBe('original');
  });

  it('has expected feature defaults', () => {
    expect(DEFAULT_CONFIG.embedChapters).toBe(true);
  });
});

describe('VIDEO_EXTENSIONS', () => {
  it('contains common video formats', () => {
    expect(VIDEO_EXTENSIONS).toContain('.mp4');
    expect(VIDEO_EXTENSIONS).toContain('.mkv');
    expect(VIDEO_EXTENSIONS).toContain('.mov');
    expect(VIDEO_EXTENSIONS).toContain('.webm');
    expect(VIDEO_EXTENSIONS).toContain('.avi');
  });

  it('every extension starts with a dot', () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(ext).toMatch(/^\./);
    }
  });
});

describe('AUDIO_EXTENSIONS', () => {
  it('contains common audio formats', () => {
    expect(AUDIO_EXTENSIONS).toContain('.mp3');
    expect(AUDIO_EXTENSIONS).toContain('.wav');
    expect(AUDIO_EXTENSIONS).toContain('.m4a');
    expect(AUDIO_EXTENSIONS).toContain('.flac');
    expect(AUDIO_EXTENSIONS).toContain('.ogg');
  });

  it('every extension starts with a dot', () => {
    for (const ext of AUDIO_EXTENSIONS) {
      expect(ext).toMatch(/^\./);
    }
  });
});

describe('LOUDNORM_PARAMS', () => {
  it('matches the YouTube Music EBU R128 spec', () => {
    expect(LOUDNORM_PARAMS).toBe('I=-14:LRA=11:TP=-1');
  });
});

describe('getSourcePaths', () => {
  it('returns paths from files type source', () => {
    expect(
      getSourcePaths({ type: 'files', paths: ['a.mp4', 'b.mkv'] }),
    ).toEqual(['a.mp4', 'b.mkv']);
  });

  it('returns path wrapped in array from folder type source', () => {
    expect(getSourcePaths({ type: 'folder', path: '/videos' })).toEqual([
      '/videos',
    ]);
  });

  it('returns [] for null source', () => {
    expect(getSourcePaths(null)).toEqual([]);
  });

  it('returns [] for empty files paths', () => {
    expect(getSourcePaths({ type: 'files', paths: [] })).toEqual([]);
  });

  it('returns [] for folder with empty path', () => {
    expect(getSourcePaths({ type: 'folder', path: '' })).toEqual([]);
  });
});
