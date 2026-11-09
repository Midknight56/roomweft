import { roomModel } from './room-model';

export interface PlanRectangle { left: number; right: number; top: number; bottom: number }

/** Frustum for the top camera whose canvas is mirrored horizontally. */
export function planFrustum(width: number, height: number, free: PlanRectangle): PlanRectangle {
  // Include the four centimetre walls and window trim outside the floor.
  const scale = Math.min(Math.max(1, free.right - free.left) / (roomModel().room.width + 8), Math.max(1, free.bottom - free.top) / (roomModel().room.depth + 8));
  const x = ((free.left + free.right) / 2 - width / 2) / scale;
  const y = ((free.top + free.bottom) / 2 - height / 2) / scale;
  return { left: x - width / (2 * scale), right: x + width / (2 * scale), top: y + height / (2 * scale), bottom: y - height / (2 * scale) };
}
