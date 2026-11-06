import type { Dimensions, Door, Room, RoomWindow } from "./room";

export type Rotation = 0 | 90 | 180 | 270;
export interface Footprint {
  id: string;
  label: string;
  kind: string;
  x: number;
  z: number;
  w: number;
  d: number;
  rot: Rotation;
  h: number;
  locked: boolean;
  movable?: boolean;
  followsId?: string;
  source: "owned" | "slot";
  dims: "verified" | "unverified";
  nominal?: true;
}
export interface Point { x: number; z: number }
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface FitOptions {
  /** All monetary values are integer cents. Only slot prices count. */
  prices?: Readonly<Record<string, number>>;
  budget?: number;
}
export interface WalkwayTarget {
  id: string;
  target: Point;
  reachable: boolean;
  pinch: Point[];
}
export interface FitReport {
  /** The ids that fail each geometric check. */
  inside: string[];
  overlaps: [string, string][];
  doorSwing: string[];
  walkway: { reachable: boolean; targets: WalkwayTarget[]; pinch: Point[] };
  window: string[];
  budget: { total: number; budget: number; over: number };
  unverified: string[];
  passes: boolean;
  messages: string[];
}

export function footprintBounds(item: Footprint): Bounds {
  const turned = item.rot === 90 || item.rot === 270;
  const w = turned ? item.d : item.w;
  const d = turned ? item.w : item.d;
  return { minX: item.x - w / 2, maxX: item.x + w / 2, minZ: item.z - d / 2, maxZ: item.z + d / 2 };
}

function contains(point: Point, box: Bounds, growth = 0): boolean {
  return point.x > box.minX - growth && point.x < box.maxX + growth
    && point.z > box.minZ - growth && point.z < box.maxZ + growth;
}

function hitsSwing(box: Bounds, door: Door): boolean {
  const minX = Math.max(box.minX, door.hinge.x);
  const minZ = Math.max(box.minZ, door.hinge.z);
  if (minX > box.maxX || minZ > box.maxZ) return false;
  return (minX - door.hinge.x) ** 2 + (minZ - door.hinge.z) ** 2 <= door.radius ** 2;
}

const STEP = 5;
const CLEARANCE = 38;
const directions: Record<Rotation, Point> = {
  0: { x: 0, z: 1 }, 90: { x: 1, z: 0 }, 180: { x: 0, z: -1 }, 270: { x: -1, z: 0 },
};

function checkWalkway(layout: readonly Footprint[], room: Room, door: Door): FitReport["walkway"] {
  const obstacles = layout.filter(item => item.kind !== "rug").map(item => ({ item, box: footprintBounds(item) }));
  const columns = Math.floor(room.width / STEP);
  const rows = Math.floor(room.depth / STEP);
  const count = columns * rows;
  const pointAt = (index: number): Point => ({ x: (index % columns + 0.5) * STEP, z: (Math.floor(index / columns) + 0.5) * STEP });
  const indexAt = (point: Point): number => Math.floor(point.z / STEP) * columns + Math.floor(point.x / STEP);
  const neighbours = (index: number): number[] => {
    const x = index % columns;
    const z = Math.floor(index / columns);
    const result: number[] = [];
    if (x > 0) result.push(index - 1);
    if (x + 1 < columns) result.push(index + 1);
    if (z > 0) result.push(index - columns);
    if (z + 1 < rows) result.push(index + columns);
    return result;
  };
  const wallBlocks = (p: Point): boolean => {
    const inEntrance = p.x >= door.opening.minX + CLEARANCE && p.x <= door.opening.maxX - CLEARANCE;
    return p.x < CLEARANCE || p.x > room.width - CLEARANCE || p.z > room.depth - CLEARANCE
      || (p.z < CLEARANCE && !inEntrance);
  };
  const blocked = Array.from({ length: count }, (_, index) => {
    const p = pointAt(index);
    return wallBlocks(p) || obstacles.some(({ box }) => contains(p, box, CLEARANCE));
  });
  // The 80 cm opening has a 4 cm centre corridor. Seed the nearest grid column
  // at its exact centre so a 5 cm grid does not erase that corridor.
  const entranceX = (door.opening.minX + door.opening.maxX) / 2;
  const entranceIndex = indexAt({ x: entranceX, z: STEP / 2 });
  for (let row = 0; row * STEP < CLEARANCE; row++) {
    const index = row * columns + entranceIndex;
    const p = { x: entranceX, z: (row + 0.5) * STEP };
    blocked[index] = wallBlocks(p) || obstacles.some(({ box }) => contains(p, box, CLEARANCE));
  }
  const previous = new Int32Array(count).fill(-1);
  const queue: number[] = [];
  if (!blocked[entranceIndex]) {
    previous[entranceIndex] = entranceIndex;
    queue.push(entranceIndex);
  }
  for (let head = 0; head < queue.length; head++) {
    for (const next of neighbours(queue[head])) {
      if (blocked[next] || previous[next] !== -1) continue;
      previous[next] = queue[head];
      queue.push(next);
    }
  }
  const targets = layout.filter(item => item.id === "desk-chair" || item.id === "reading-chair").map(item => {
    const box = footprintBounds(item);
    const direction = directions[item.rot];
    const radius = direction.x === 0 ? (box.maxZ - box.minZ) / 2 : (box.maxX - box.minX) / 2;
    const target = { x: item.x + direction.x * (radius + 10), z: item.z + direction.z * (radius + 10) };
    const zoneCentre = { x: item.x + direction.x * (radius + 30), z: item.z + direction.z * (radius + 30) };
    const halfWidth = direction.x === 0 ? (box.maxX - box.minX) / 2 : 30;
    const halfDepth = direction.z === 0 ? (box.maxZ - box.minZ) / 2 : 30;
    const reachable = queue.some(index => {
      const p = pointAt(index);
      return p.x >= zoneCentre.x - halfWidth && p.x <= zoneCentre.x + halfWidth
        && p.z >= zoneCentre.z - halfDepth && p.z <= zoneCentre.z + halfDepth;
    });
    const pinch: Point[] = [];
    if (!reachable) {
      // A second BFS permits blocked cells and finds the shortest partial route
      // to the front zone centre. Keep cells where two clearance regions meet as a band.
      const route = new Int32Array(count).fill(-1);
      const search = [entranceIndex];
      route[entranceIndex] = entranceIndex;
      let best = entranceIndex;
      const distance = (index: number) => {
        const p = pointAt(index);
        return Math.abs(p.x - zoneCentre.x) + Math.abs(p.z - zoneCentre.z);
      };
      for (let head = 0; head < search.length; head++) {
        const current = search[head];
        if (distance(current) < distance(best)) best = current;
        if (distance(current) < STEP) { best = current; break; }
        for (const next of neighbours(current)) {
          if (route[next] !== -1) continue;
          const p = pointAt(next);
          if (obstacles.some(({ box: obstacle }) => contains(p, obstacle))) continue;
          route[next] = current;
          search.push(next);
        }
      }
      const band = new Set<number>();
      let current = best;
      while (true) {
        for (const index of [current, ...neighbours(current)]) {
          const p = pointAt(index);
          const contacts = obstacles.filter(({ box: obstacle }) => contains(p, obstacle, CLEARANCE)).length;
          if (contacts >= 2 || (contacts >= 1 && wallBlocks(p))) band.add(index);
        }
        if (route[current] === current) break;
        current = route[current];
      }
      for (const index of band) pinch.push(pointAt(index));
    }
    return { id: item.id, target, reachable, pinch };
  });
  const pinch = [...new Map(targets.flatMap(target => target.pinch).map(p => [`${p.x},${p.z}`, p])).values()];
  return { reachable: targets.every(target => target.reachable), targets, pinch };
}

export function checkFit(layout: readonly Footprint[], room: Room, door: Door, window: RoomWindow, opts: FitOptions = {}): FitReport {
  const inside: string[] = [];
  const overlaps: [string, string][] = [];
  const doorSwing: string[] = [];
  const windowWarnings: string[] = [];
  const messages: string[] = [];
  for (const [index, item] of layout.entries()) {
    const box = footprintBounds(item);
    if (![item.x, item.z, item.w, item.d, item.h].every(Number.isFinite) || item.w <= 0 || item.d <= 0 || item.h <= 0
      || box.minX < 2 || box.maxX > room.width - 2 || box.minZ < 2 || box.maxZ > room.depth - 2) {
      inside.push(item.id);
      messages.push(`The ${item.label} is outside the wall margin.`);
    }
    if (item.kind !== "rug" && hitsSwing(box, door)) {
      doorSwing.push(item.id);
      messages.push(`The ${item.label} blocks the door swing.`);
    }
    if (item.h > window.sill && box.maxZ >= room.depth - 40 && box.minX < window.maxX && box.maxX > window.minX) {
      windowWarnings.push(item.id);
      messages.push(`The ${item.label} blocks the window.`);
    }
    if (item.kind === "rug") continue;
    for (const other of layout.slice(index + 1)) {
      if (other.kind === "rug") continue;
      const next = footprintBounds(other);
      if (Math.min(box.maxX, next.maxX) - Math.max(box.minX, next.minX) > 1
        && Math.min(box.maxZ, next.maxZ) - Math.max(box.minZ, next.minZ) > 1) {
        overlaps.push([item.id, other.id]);
        messages.push(`The ${item.label} overlaps the ${other.label}.`);
      }
    }
  }
  const walkway = checkWalkway(layout, room, door);
  for (const target of walkway.targets.filter(target => !target.reachable)) {
    messages.push(`The walkway to the ${layout.find(item => item.id === target.id)?.label} is under 76 cm wide.`);
  }
  const prices = layout.filter(item => item.source === "slot").map(item => opts.prices?.[item.id] ?? 0);
  const budget = opts.budget ?? 0;
  if (![budget, ...prices].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Use nonnegative integer cents for money.");
  const total = prices.reduce((sum, price) => sum + price, 0);
  if (!Number.isSafeInteger(total)) throw new Error("The basket total is too large.");
  const over = Math.max(0, total - budget);
  if (over > 0) messages.push(`The basket is over budget by $${(over / 100).toFixed(2)}.`);
  const unverified = layout.filter(item => item.dims === "unverified").map(item => item.id);
  for (const item of layout.filter(item => item.dims === "unverified")) messages.push(`The ${item.label} has unverified dimensions.`);
  return {
    inside, overlaps, doorSwing, walkway, window: windowWarnings,
    budget: { total, budget, over }, unverified,
    passes: inside.length === 0 && overlaps.length === 0 && doorSwing.length === 0 && walkway.reachable && over === 0,
    messages,
  };
}

export function dimsFromOffer(dimensions: unknown, kind?: string): Dimensions | null {
  if (typeof dimensions !== "object" || dimensions === null) return null;
  const values = dimensions as Record<string, unknown>;
  const factors: Record<string, number> = { in: 2.54, cm: 1, mm: 0.1, ft: 30.48, m: 100 };
  function convert(value: unknown, min = 10, max = 400): number | null {
    if (typeof value !== "object" || value === null) return null;
    const measurement = value as Record<string, unknown>;
    if (typeof measurement.number !== "number" || typeof measurement.unit !== "string") return null;
    const cm = measurement.number * (factors[measurement.unit] ?? NaN);
    if (!Number.isFinite(cm) || cm < min || cm > max) return null;
    return Math.round(cm * 10) / 10;
  }
  if (kind === "rug") {
    const w = convert(values.width, 30, 600);
    const d = convert(values.length, 30, 600);
    const h = convert(values.height, 0, 400);
    return w === null || d === null ? null : { w, d, h: h === null ? 1 : h };
  }
  const w = convert(values.width);
  const d = convert(values.length);
  const h = convert(values.height);
  return w === null || d === null || h === null ? null : { w, d, h };
}

export function moveItem<T extends Footprint>(layout: readonly T[], id: string, x: number, z: number, rot: Rotation): T[] | { error: string } {
  const item = layout.find(entry => entry.id === id);
  if (!item) return { error: "The item was not found." };
  if (item.locked || item.movable === false) return { error: `The ${item.label} cannot move.` };
  if (![x, z].every(Number.isFinite) || ![0, 90, 180, 270].includes(rot)) return { error: "Use a valid position and rotation." };
  const angle = (rot - item.rot) * Math.PI / 180;
  return layout.map(entry => {
    if (entry.id === id) return { ...entry, x, z, rot };
    if (entry.followsId !== id) return { ...entry };
    const dx = entry.x - item.x;
    const dz = entry.z - item.z;
    return {
      ...entry, x: x + dx * Math.cos(angle) + dz * Math.sin(angle),
      z: z - dx * Math.sin(angle) + dz * Math.cos(angle),
      rot: ((entry.rot + rot - item.rot + 360) % 360) as Rotation,
    };
  });
}
