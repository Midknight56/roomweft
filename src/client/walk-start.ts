import type { Footprint, Point } from '../shared/fit';
import { ROOM } from '../shared/room';
import { collides } from './helpers';
import { doorSpec } from './door';

export function doorLeafDistance(point: Point): number {
  const angle = doorSpec.angle * Math.PI / 180;
  const dx = Math.cos(angle) * doorSpec.width, dz = Math.sin(angle) * doorSpec.width;
  const t = Math.max(0, Math.min(1, ((point.x - doorSpec.x) * dx + (point.z - doorSpec.z) * dz) / doorSpec.width ** 2));
  return Math.hypot(point.x - doorSpec.x - t * dx, point.z - doorSpec.z - t * dz);
}

export function walkStart(layout: readonly Footprint[]): Point | null {
  const preferred = { x: ROOM.width / 2, z: 55 };
  const candidates: Point[] = [preferred];
  for (let z = 35; z <= ROOM.depth - 35; z += 10)
    for (let x = 35; x <= ROOM.width - 35; x += 10) candidates.push({ x, z });
  candidates.sort((a, b) => Math.hypot(a.x - preferred.x, a.z - preferred.z) - Math.hypot(b.x - preferred.x, b.z - preferred.z));
  return candidates.find(point => doorLeafDistance(point) >= 45 && !collides(point, layout)) ?? null;
}
