import type { Footprint, Rotation } from "./fit";

export interface Room { width: number; depth: number; height: number }
export interface Door {
  wall: "south";
  opening: { minX: number; maxX: number };
  hinge: { x: number; z: number };
  radius: number;
  quadrant: { x: 1; z: 1 };
}
export interface RoomWindow { wall: "north"; minX: number; maxX: number; sill: number; top: number }
export interface Dimensions { w: number; d: number; h: number }
export type SlotId = "reading-chair" | "floor-lamp" | "side-table" | "rug";
export const SLOT_NOUNS: Record<SlotId, string> = {
  'reading-chair': 'reading chair', 'floor-lamp': 'floor lamp', 'side-table': 'side table', rug: 'area rug 5x7',
};
export const BRIEF_WORDS = [
  'tall', 'slim', 'compact', 'low', 'small', 'wide', 'narrow', 'short', 'round', 'square', 'oval',
  'black', 'white', 'grey', 'charcoal', 'navy', 'green', 'cream', 'beige', 'brown', 'blue', 'red', 'rust', 'natural',
  'oak', 'walnut', 'wood', 'metal', 'brass', 'linen', 'wool', 'velvet', 'leather', 'jute', 'cotton', 'rattan',
  'bamboo', 'glass', 'steel', 'ceramic', 'paper', 'adjustable', 'arc', 'swivel', 'upholstered', 'flatweave',
  'plush', 'striped', 'warm', 'bright', 'soft', 'firm', 'woven', 'textured', 'padded', 'dimmable', 'storage',
  'shelf', 'solid', 'neutral',
] as const;
/** Drawing boxes only. These never establish product fit. */
export const NOMINAL_DIMS: Record<SlotId, Dimensions> = {
  'reading-chair': { w: 70, d: 70, h: 80 },
  'floor-lamp': { w: 40, d: 40, h: 150 },
  'side-table': { w: 45, d: 45, h: 55 },
  rug: { w: 150, d: 210, h: 1 },
};
export const SLOT_SHARES: Record<SlotId, number> = { 'reading-chair': .40, 'floor-lamp': .20, 'side-table': .15, rug: .25 };
export function slotCapCents(budgetCents: number, slot: SlotId): number { return Math.floor(budgetCents * SLOT_SHARES[slot]); }
export type Facing = "north" | "east" | "south" | "west";
export type Anchor =
  | ({ kind: "corner" } & ({ east: number; west?: never } | { west: number; east?: never }) & ({ south: number; north?: never } | { north: number; south?: never }))
  | { kind: "beside"; east: number; followsId: string; gap: number }
  | { kind: "centre"; x: number; z: number };
export interface Slot {
  id: SlotId;
  label: string;
  kind: string;
  anchor: Anchor;
  facing: Facing;
  maxBox?: { w: number; d: number };
}

export const ROOM = { width: 380, depth: 320, height: 260 } as const satisfies Room;
// The east corner is 76 cm wide, so deeper real accent chairs meet this swing.
export const DOOR = {
  wall: "south", opening: { minX: 220, maxX: 300 },
  hinge: { x: 220, z: 0 }, radius: 80, quadrant: { x: 1, z: 1 },
} as const satisfies Door;
export const WINDOW = { wall: "north", minX: 140, maxX: 260, sill: 90, top: 220 } as const satisfies RoomWindow;

export const OWNED_ITEMS = [
  { id: "desk", label: "Desk", kind: "desk", w: 120, d: 60, h: 75, x: 310, z: 285, rot: 0, locked: true, movable: true },
  { id: "desk-chair", label: "Desk chair", kind: "chair", w: 55, d: 55, h: 90, x: 312.5, z: 222.5, rot: 180, locked: true, movable: true, followsId: "desk" },
  { id: "bookshelf", label: "Bookshelf", kind: "bookshelf", w: 80, d: 30, h: 180, x: 20, z: 180, rot: 90, locked: false, movable: true },
] as const satisfies readonly Omit<Footprint, "source" | "dims">[];

export const SLOTS = [
  { id: "reading-chair", label: "Reading chair", kind: "chair", anchor: { kind: "corner", east: 376, south: 4 }, facing: "west" },
  { id: "floor-lamp", label: "Floor lamp", kind: "lamp", anchor: { kind: "corner", west: 4, north: 316 }, facing: "east" },
  { id: "side-table", label: "Side table", kind: "table", anchor: { kind: "beside", east: 376, followsId: "reading-chair", gap: 6 }, facing: "north" },
  { id: "rug", label: "Rug", kind: "rug", anchor: { kind: "centre", x: 190, z: 150 }, facing: "north" },
] as const satisfies readonly Slot[];

const rotations: Record<Facing, Rotation> = { north: 0, east: 90, south: 180, west: 270 };

export function placeAtAnchor(slot: Slot, dims: Dimensions, placed: readonly Footprint[]): { x: number; z: number; rot: Rotation } {
  const rot = rotations[slot.facing];
  const w = rot === 90 || rot === 270 ? dims.d : dims.w;
  const d = rot === 90 || rot === 270 ? dims.w : dims.d;
  const anchor = slot.anchor;
  if (anchor.kind === "centre") return { x: anchor.x, z: anchor.z, rot };
  if (anchor.kind === "corner") return { x: anchor.east !== undefined ? anchor.east - w / 2 : anchor.west + w / 2, z: anchor.south !== undefined ? anchor.south + d / 2 : anchor.north - d / 2, rot };
  const chair = placed.find(item => item.id === anchor.followsId);
  if (!chair) throw new Error("Place the reading chair before the side table.");
  const chairDepth = chair.rot === 90 || chair.rot === 270 ? chair.w : chair.d;
  return { x: anchor.east - w / 2, z: chair.z + chairDepth / 2 + anchor.gap + d / 2, rot };
}

export interface Style {
  id: "warm-reading" | "calm-studio" | "night-desk";
  label: string;
  blurb: string;
  palette: { wall: string; floor: string; trim: string; accent: string };
  light: { kind: "warm" | "daylight" | "evening"; colour: string; intensity: number };
  queries: Record<SlotId, string>;
  defaultBudget: number;
}

export const STYLES = [
  {
    id: "warm-reading", label: "Warm reading corner", blurb: "Soft fabric and warm wood for time with a book.",
    palette: { wall: "#eee4d5", floor: "#a77d53", trim: "#faf2e5", accent: "#b96340" },
    light: { kind: "warm", colour: "#ffe1ad", intensity: 1.2 }, defaultBudget: 700,
    queries: { "reading-chair": "small upholstered reading armchair", "floor-lamp": "warm arc floor lamp", "side-table": "small round wood side table", rug: "warm wool area rug 5x7" },
  },
  {
    id: "calm-studio", label: "Calm studio", blurb: "Light wood and quiet colours for a calm room.",
    palette: { wall: "#e5eae5", floor: "#c5ad8a", trim: "#f7f8f2", accent: "#6e9185" },
    light: { kind: "daylight", colour: "#f3f7ff", intensity: 1 }, defaultBudget: 900,
    queries: { "reading-chair": "compact linen accent chair", "floor-lamp": "slim white floor lamp", "side-table": "small oak side table", rug: "neutral flatweave area rug 5x7" },
  },
  {
    id: "night-desk", label: "Night desk", blurb: "Deep colours and soft light for the evening.",
    palette: { wall: "#313d50", floor: "#735d50", trim: "#bec7ce", accent: "#cf9c59" },
    light: { kind: "evening", colour: "#ffcb8a", intensity: 0.8 }, defaultBudget: 800,
    queries: { "reading-chair": "small charcoal reading chair", "floor-lamp": "brass adjustable floor lamp", "side-table": "small dark wood side table", rug: "navy area rug 5x7" },
  },
] as const satisfies readonly Style[];
