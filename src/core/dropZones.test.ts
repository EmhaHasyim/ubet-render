// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  dispatchDropPaths,
  filterPathsByExt,
  scalePoint,
  ZONE_IDS,
  zoneFromElement,
} from './dropZones';

/** Test double for `Element.closest`: reports membership by element id. */
function fakeElement(id: string | null) {
  return {
    closest: (selector: string) =>
      id !== null && selector === `#${id}` ? {} : null,
  };
}

describe('zoneFromElement', () => {
  it.each([
    [ZONE_IDS.video, 'video'],
    [ZONE_IDS.audio, 'audio'],
    [ZONE_IDS.output, 'output'],
  ] as const)('maps #%s to %s', (id, zone) => {
    expect(zoneFromElement(fakeElement(id))).toBe(zone);
  });

  it('returns null for elements outside all zones', () => {
    expect(zoneFromElement(fakeElement('unrelated'))).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(zoneFromElement(null)).toBeNull();
    expect(zoneFromElement(undefined)).toBeNull();
  });
});

describe('filterPathsByExt', () => {
  it('keeps matching extensions case-insensitively', () => {
    expect(
      filterPathsByExt(['A.MP4', 'b.mkv', 'c.txt'], ['.mp4', '.mkv']),
    ).toEqual(['A.MP4', 'b.mkv']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterPathsByExt(['readme.txt'], ['.mp4'])).toEqual([]);
  });
});

describe('dispatchDropPaths', () => {
  it('dispatches video drops with filtered paths', () => {
    expect(
      dispatchDropPaths(['/v/a.mp4', '/readme.txt', '/v/b.mkv'], 'video'),
    ).toEqual({ kind: 'video', paths: ['/v/a.mp4', '/v/b.mkv'] });
  });

  it('ignores video drops with no matching files', () => {
    expect(dispatchDropPaths(['/readme.txt'], 'video')).toEqual({
      kind: 'ignore',
    });
  });

  it('dispatches audio drops with filtered paths', () => {
    expect(dispatchDropPaths(['/a/song.mp3', '/a/cover.png'], 'audio')).toEqual(
      { kind: 'audio', paths: ['/a/song.mp3'] },
    );
  });

  it('ignores audio drops with no matching files', () => {
    expect(dispatchDropPaths(['/v/a.mp4'], 'audio')).toEqual({
      kind: 'ignore',
    });
  });

  it('takes the first path for output drops', () => {
    expect(dispatchDropPaths(['/out/a', '/out/b'], 'output')).toEqual({
      kind: 'output',
      path: '/out/a',
    });
  });

  it('ignores empty paths and null zones', () => {
    expect(dispatchDropPaths([], 'video')).toEqual({ kind: 'ignore' });
    expect(dispatchDropPaths(['/v/a.mp4'], null)).toEqual({ kind: 'ignore' });
  });
});

describe('scalePoint', () => {
  it('divides by the device pixel ratio', () => {
    expect(scalePoint(200, 100, 2)).toEqual({ x: 100, y: 50 });
  });

  it('falls back to ratio 1 for falsy ratios', () => {
    expect(scalePoint(200, 100, 0)).toEqual({ x: 200, y: 100 });
  });
});
