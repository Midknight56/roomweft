import { describe, expect, it } from "vitest";
import { checkFit, footprintBounds, type Footprint } from "../../src/shared/fit";
import { DOOR, OWNED_ITEMS, placeAtAnchor, ROOM, SLOTS, STYLES, WINDOW, SLOT_SHARES, slotCapCents } from "../../src/shared/room";

describe("room data", () => {
  it("keeps owned furniture and typical anchored items inside the room", () => {
    const placed: Footprint[] = OWNED_ITEMS.map(item => ({ ...item, source: "owned", dims: "verified" }));
    for (const slot of SLOTS) {
      const dims = slot.id === "rug" ? { w: 150, d: 210, h: 10 }
        : slot.id === "reading-chair" ? { w: 60, d: 70, h: 80 } : { w: 30, d: 30, h: 50 };
      placed.push({ ...dims, ...placeAtAnchor(slot, dims, placed), id: slot.id, label: slot.label, kind: slot.kind, locked: false, source: "slot", dims: "verified" });
    }
    expect(checkFit(placed, ROOM, DOOR, WINDOW).inside).toEqual([]);
    const chair = footprintBounds(placed.find(item => item.id === "reading-chair")!);
    const table = footprintBounds(placed.find(item => item.id === "side-table")!);
    expect(chair.maxX).toBe(376);
    expect(chair.minZ).toBe(4);
    expect(table.minZ - chair.maxZ).toBe(6);
  });
  it("passes the default owned layout", () => {
    expect(checkFit(OWNED_ITEMS.map(item => ({ ...item, source: "owned", dims: "verified" })), ROOM, DOOR, WINDOW).passes).toBe(true);
  });
  it("requires the chair before the side table", () => {
    expect(() => placeAtAnchor(SLOTS[2], { w: 30, d: 30, h: 50 }, [])).toThrow("reading chair");
  });
  it("gives every style distinct scene data and all four shopping queries", () => {
    expect(STYLES.map(style => style.defaultBudget)).toEqual([700, 900, 800]);
    expect(new Set(STYLES.map(style => style.palette.wall)).size).toBe(3);
    for (const style of STYLES) expect(Object.keys(style.queries).sort()).toEqual(SLOTS.map(slot => slot.id).sort());
  });
});

it('allocates the whole budget with rounded down slot caps', () => {
  expect(Object.values(SLOT_SHARES).reduce((a,b) => a+b,0)).toBe(1);
  expect(SLOTS.map(s => slotCapCents(90000,s.id))).toEqual([36000,18000,13500,22500]);
  expect(slotCapCents(15101,'side-table')).toBe(2265);
});
it.each([[54,35.6],[32,96.5],[59.7,58.4],[82.6,33],[35.6,35.6]])('places a %s by %s lamp clear of walls, furniture and window', (w,d) => {
  const dims = {w,d,h:180}; const slot = SLOTS[1];
  const lamp: Footprint = { ...dims, ...placeAtAnchor(slot,dims,[]), id:slot.id,label:slot.label,kind:slot.kind,locked:false,source:'slot',dims:'verified' };
  expect(lamp.rot).toBe(90);
  expect(footprintBounds(lamp).minX).toBeCloseTo(4); expect(footprintBounds(lamp).maxZ).toBeCloseTo(316);
  const fit = checkFit([...OWNED_ITEMS.map(item => ({...item,source:'owned' as const,dims:'verified' as const})),lamp],ROOM,DOOR,WINDOW);
  expect(fit.inside).toEqual([]); expect(fit.overlaps).toEqual([]); expect(fit.window).toEqual([]);
});

describe("measured rooms", () => {
  it("builds exactly today's room from the default spec", async () => {
    const { DEFAULT_ROOM_SPEC, roomFromSpec } = await import("../../src/shared/room");
    const model = roomFromSpec(DEFAULT_ROOM_SPEC);
    expect(model.room).toEqual(ROOM);
    expect(model.door).toEqual(DOOR);
    expect(model.window).toEqual(WINDOW);
    expect(model.ownedItems).toEqual(OWNED_ITEMS);
    expect(model.slots).toEqual(SLOTS);
  });
  it("explains each bad measurement next to its field", async () => {
    const { DEFAULT_ROOM_SPEC, validateRoomSpec } = await import("../../src/shared/room");
    const spec = structuredClone(DEFAULT_ROOM_SPEC);
    expect(validateRoomSpec(spec)).toEqual([]);
    expect(validateRoomSpec({ ...spec, width: 150 })).toContainEqual({ field: "width", message: "Use a width from 200 to 800 cm." });
    expect(validateRoomSpec({ ...spec, depth: 900 })).toContainEqual({ field: "depth", message: "Use a depth from 200 to 800 cm." });
    expect(validateRoomSpec({ ...spec, door: { left: 320, width: 80 } })[0]).toMatchObject({ field: "door-left" });
    expect(validateRoomSpec({ ...spec, door: { left: 5, width: 80 } })[0]).toMatchObject({ field: "door-left" });
    expect(validateRoomSpec({ ...spec, door: { left: 220, width: 60 } })).toContainEqual({ field: "door-width", message: "Use a door width from 70 to 100 cm." });
    expect(validateRoomSpec({ ...spec, owned: { ...spec.owned, bookshelf: { w: 80, d: 30, h: 400 } } })).toContainEqual({ field: "size-bookshelf-h", message: "Use a bookshelf height from 20 to 300 cm." });
    const big = { ...spec, width: 220, depth: 220, door: { left: 20, width: 80 }, owned: { ...spec.owned, desk: { w: 250, d: 60, h: 75 } } };
    expect(validateRoomSpec(big)).toContainEqual({ field: "size-desk-w", message: "The desk does not fit inside this room." });
    expect(validateRoomSpec({ ...spec, width: "wide" })[0]).toMatchObject({ field: "width" });
    expect(validateRoomSpec(null)[0]).toMatchObject({ field: "width" });
  });
  it("keeps every piece inside the walls of a small and a large room", async () => {
    const { DEFAULT_ROOM_SPEC, roomFromSpec } = await import("../../src/shared/room");
    for (const [width, depth] of [[300, 280], [450, 360]]) {
      const model = roomFromSpec({ ...DEFAULT_ROOM_SPEC, width, depth, door: { left: 140, width: 80 } });
      expect(model.room).toEqual({ width, depth, height: 260 });
      expect(model.door).toMatchObject({ opening: { minX: 140, maxX: 220 }, hinge: { x: 140, z: 0 }, radius: 80 });
      expect((model.window.minX + model.window.maxX) / 2).toBeCloseTo(width / 2 + 10);
      const owned: Footprint[] = model.ownedItems.map(item => ({ ...item, source: "owned", dims: "verified" }));
      expect(checkFit(owned, model.room, model.door, model.window).inside).toEqual([]);
      const desk = owned.find(item => item.id === "desk")!;
      expect(footprintBounds(desk).maxX).toBe(width - 10);
      expect(footprintBounds(desk).maxZ).toBe(depth - 5);
      expect(footprintBounds(owned.find(item => item.id === "bookshelf")!).minX).toBe(5);
    }
  });
});
