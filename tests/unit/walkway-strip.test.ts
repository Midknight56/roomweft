import { describe, expect, it } from 'vitest';
import type { WalkwayTarget } from '../../src/shared/fit';
import { pathDots, walkwayEdgeSegments, walkwayStripSegments } from '../../src/client/walkway-strip';

describe('walkway edge segments', () => {
  it('places two 5 cm edges along each segment long side', () => {
    expect(walkwayEdgeSegments([{ x: 100, z: 40 }, { x: 200, z: 40 }])).toEqual([
      { x: 150, z: 4.5, width: 100, depth: 5 },
      { x: 150, z: 75.5, width: 100, depth: 5 },
    ]);
    expect(walkwayEdgeSegments([{ x: 60, z: 100 }, { x: 60, z: 250 }])).toEqual([
      { x: 24.5, z: 175, width: 5, depth: 150 },
      { x: 95.5, z: 175, width: 5, depth: 150 },
    ]);
    expect(walkwayEdgeSegments([{ x: 0, z: 0 }, { x: 100, z: 0 }])).toHaveLength(2);
  });
});

describe('walkway strip segments', () => {
  it('draws nothing and does not throw for a target with no path field', () => {
    const target: WalkwayTarget = {
      id: 'desk-chair',
      target: { x: 100, z: 100 },
      reachable: true,
      pinch: [],
    };
    expect(target.path).toBeUndefined();
    expect(() => walkwayStripSegments(target.path)).not.toThrow();
    expect(walkwayStripSegments(target.path)).toEqual([]);
  });

  it('draws nothing for undefined, empty, or single point paths', () => {
    expect(walkwayStripSegments(undefined)).toEqual([]);
    expect(walkwayStripSegments(null)).toEqual([]);
    expect(walkwayStripSegments([])).toEqual([]);
    expect(walkwayStripSegments([{ x: 50, z: 50 }])).toEqual([]);
  });

  it('creates 76 cm wide rectangular segments along straight runs', () => {
    const horizontal = walkwayStripSegments([{ x: 100, z: 40 }, { x: 200, z: 40 }]);
    expect(horizontal).toHaveLength(1);
    expect(horizontal[0]).toMatchObject({
      x: 150,
      z: 40,
      width: 100,
      depth: 76,
    });

    const vertical = walkwayStripSegments([{ x: 60, z: 100 }, { x: 60, z: 250 }]);
    expect(vertical).toHaveLength(1);
    expect(vertical[0]).toMatchObject({
      x: 60,
      z: 175,
      width: 76,
      depth: 150,
    });
  });

  it('creates consecutive segments and corner squares for paths that turn corners', () => {
    const path = [
      { x: 262.5, z: 2.5 },
      { x: 262.5, z: 150 },
      { x: 310, z: 150 },
    ];
    const segments = walkwayStripSegments(path, 76);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({
      x: 262.5,
      z: 76.25,
      width: 76,
      depth: 147.5,
    });
    expect(segments[1]).toMatchObject({
      x: 286.25,
      z: 150,
      width: 47.5,
      depth: 76,
    });
    expect(segments[2]).toMatchObject({
      x: 262.5,
      z: 150,
      width: 76,
      depth: 76,
    });
  });

  it('omits w and d duplicate fields from segments', () => {
    const segments = walkwayStripSegments([{ x: 10, z: 10 }, { x: 50, z: 10 }]);
    expect(segments).toHaveLength(1);
    expect('w' in segments[0]).toBe(false);
    expect('d' in segments[0]).toBe(false);
  });
});

describe('path dots', () => {
  it('returns an empty list for missing or single point paths', () => {
    expect(pathDots(undefined)).toEqual([]);
    expect(pathDots(null)).toEqual([]);
    expect(pathDots([])).toEqual([]);
    expect(pathDots([{ x: 10, z: 10 }])).toEqual([]);
  });

  it('returns an empty list for non positive spacing', () => {
    expect(pathDots([{ x: 0, z: 0 }, { x: 50, z: 0 }], 0)).toEqual([]);
    expect(pathDots([{ x: 0, z: 0 }, { x: 50, z: 0 }], -5)).toEqual([]);
  });

  it('places dots every 12 cm on a straight path including both ends', () => {
    const path = [{ x: 0, z: 0 }, { x: 60, z: 0 }];
    const dots = pathDots(path, 12);
    expect(dots).toEqual([
      { x: 0, z: 0 },
      { x: 12, z: 0 },
      { x: 24, z: 0 },
      { x: 36, z: 0 },
      { x: 48, z: 0 },
      { x: 60, z: 0 },
    ]);
  });

  it('places dots every 12 cm on an L shaped path with both ends and no corner duplicate', () => {
    const path = [
      { x: 0, z: 0 },
      { x: 60, z: 0 },
      { x: 60, z: 36 },
    ];
    const dots = pathDots(path, 12);
    expect(dots).toEqual([
      { x: 0, z: 0 },
      { x: 12, z: 0 },
      { x: 24, z: 0 },
      { x: 36, z: 0 },
      { x: 48, z: 0 },
      { x: 60, z: 0 },
      { x: 60, z: 12 },
      { x: 60, z: 24 },
      { x: 60, z: 36 },
    ]);
  });
});
