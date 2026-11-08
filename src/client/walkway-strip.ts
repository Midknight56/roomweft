import type { Point } from '../shared/fit';

export interface StripSegment {
  x: number;
  z: number;
  width: number;
  depth: number;
}

export function walkwayEdgeSegments(path?: readonly Point[] | null, width = 76, edgeWidth = 5): StripSegment[] {
  if (edgeWidth <= 0) return [];
  return walkwayStripSegments(path, width).flatMap(segment => {
    if (segment.width >= segment.depth) {
      const z = segment.depth / 2 - edgeWidth / 2;
      return [
        { x: segment.x, z: segment.z - z, width: segment.width, depth: edgeWidth },
        { x: segment.x, z: segment.z + z, width: segment.width, depth: edgeWidth },
      ];
    }
    const x = segment.width / 2 - edgeWidth / 2;
    return [
      { x: segment.x - x, z: segment.z, width: edgeWidth, depth: segment.depth },
      { x: segment.x + x, z: segment.z, width: edgeWidth, depth: segment.depth },
    ];
  });
}

export function walkwayStripSegments(path?: readonly Point[] | null, width = 76): StripSegment[] {
  if (!path || path.length < 2) return [];
  const segments: StripSegment[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minZ = Math.min(a.z, b.z);
    const maxZ = Math.max(a.z, b.z);
    const dx = maxX - minX;
    const dz = maxZ - minZ;
    if (dx === 0 && dz === 0) continue;
    if (dz === 0) {
      segments.push({ x: (minX + maxX) / 2, z: a.z, width: dx, depth: width });
    } else if (dx === 0) {
      segments.push({ x: a.x, z: (minZ + maxZ) / 2, width, depth: dz });
    } else {
      segments.push({ x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, width: dx, depth: dz });
    }
  }
  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1];
    const curr = path[i];
    const next = path[i + 1];
    const dx1 = curr.x - prev.x;
    const dz1 = curr.z - prev.z;
    const dx2 = next.x - curr.x;
    const dz2 = next.z - curr.z;
    if ((dx1 === 0 && dz1 === 0) || (dx2 === 0 && dz2 === 0)) continue;
    if (dx1 * dz2 !== dz1 * dx2 || (dx1 * dx2 + dz1 * dz2 <= 0)) {
      segments.push({ x: curr.x, z: curr.z, width, depth: width });
    }
  }
  return segments;
}

export function pathDots(path?: readonly Point[] | null, spacing = 12): Point[] {
  if (!path || path.length < 2 || spacing <= 0) return [];
  const dots: Point[] = [];
  let isFirst = true;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len === 0) continue;
    const ux = dx / len;
    const uz = dz / len;
    const startD = isFirst ? 0 : spacing;
    isFirst = false;
    for (let d = startD; d <= len + 1e-4; d += spacing) {
      dots.push({
        x: Math.round((a.x + ux * d) * 100) / 100,
        z: Math.round((a.z + uz * d) * 100) / 100,
      });
    }
  }
  return dots;
}
