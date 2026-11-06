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
