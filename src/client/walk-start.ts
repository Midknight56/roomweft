import type { Footprint, Point } from '../shared/fit';
import { roomModel } from './room-model';
import { collides } from './helpers';
import { doorSpec } from './door';

export function doorLeafDistance(point: Point): number {
  const door = doorSpec();
  const angle = door.angle * Math.PI / 180;
  const dx = Math.cos(angle) * door.width, dz = Math.sin(angle) * door.width;
  const t = Math.max(0, Math.min(1, ((point.x - door.x) * dx + (point.z - door.z) * dz) / door.width ** 2));
  return Math.hypot(point.x - door.x - t * dx, point.z - door.z - t * dz);
}

export function walkStart(layout: readonly Footprint[]): Point | null {
  const preferred = { x: roomModel().room.width / 2, z: 55 };
  const candidates: Point[] = [preferred];
  for (let z = 35; z <= roomModel().room.depth - 35; z += 10)
    for (let x = 35; x <= roomModel().room.width - 35; x += 10) candidates.push({ x, z });
  candidates.sort((a, b) => Math.hypot(a.x - preferred.x, a.z - preferred.z) - Math.hypot(b.x - preferred.x, b.z - preferred.z));
  return candidates.find(point => doorLeafDistance(point) >= 45 && !collides(point, layout)) ?? null;
}
