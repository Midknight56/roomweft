import { describe, it, expect } from 'vitest';
import { threadVisible, type Point2D, type RectLike, type ViewportLike } from '../../src/client/thread-visible';

describe('threadVisible', () => {
  const host: RectLike = { left: 0, top: 80, right: 390, bottom: 440, width: 390, height: 360 };
  const viewport: ViewportLike = { width: 390, height: 844 };

  const cases: [string, Point2D | null, RectLike | null, Point2D | null, ViewportLike, boolean][] = [
    [
      'inside',
      { x: 195, y: 260 },
      host,
      { x: 30, y: 600 },
      viewport,
      true,
    ],
    [
      'endpoint above the window',
      { x: 195, y: -50 },
      { left: 0, top: -200, right: 390, bottom: 0, width: 390, height: 200 },
      { x: 30, y: 600 },
      viewport,
      false,
    ],
    [
      'endpoint outside the room box',
      { x: 195, y: 500 },
      host,
      { x: 30, y: 600 },
      viewport,
      false,
    ],
    [
      'card off screen',
      { x: 195, y: 260 },
      host,
      { x: 30, y: 950 },
      viewport,
      false,
    ],
    [
      'card above the window',
      { x: 195, y: 260 },
      host,
      { x: 30, y: -10 },
      viewport,
      false,
    ],
    [
      'null endpoint',
      null,
      host,
      { x: 30, y: 600 },
      viewport,
      false,
    ],
    [
      'null start',
      { x: 195, y: 260 },
      host,
      null,
      viewport,
      false,
    ],
  ];

  it.each(cases)('%s', (_name, endpoint, hostRect, start, vp, expected) => {
    expect(threadVisible(endpoint, hostRect, start, vp)).toBe(expected);
  });
});
