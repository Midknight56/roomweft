import { describe, expect, it } from "vitest";
import { checkFit, doorTight, evaluateDesignFit, footprintBounds, moveItem, type Footprint } from "../../src/shared/fit";
import { DOOR, OWNED_ITEMS, placeAtAnchor, ROOM, SLOTS, WINDOW } from "../../src/shared/room";

const owned = (): Footprint[] => OWNED_ITEMS.map(item => ({ ...item, source: "owned", dims: "verified" }));
const item = (changes: Partial<Footprint> = {}): Footprint => ({
  id: "test", label: "Test item", kind: "table", x: 100, z: 100, w: 30, d: 30, h: 50,
  rot: 0, locked: false, movable: true, source: "slot", dims: "verified", ...changes,
});
const fit = (layout: Footprint[], prices = {}, budget = 0) => checkFit(layout, ROOM, DOOR, WINDOW, { prices, budget });
const chair = (size: number) => item({
  id: "reading-chair", kind: "chair", w: 60, d: size,
  ...placeAtAnchor(SLOTS[0], { w: size, d: size, h: 80 }, []),
});

describe("fit", () => {
  it("finds an 80 cm deep chair in the eastward swing but clears a 72 cm chair", () => {
    expect(fit([chair(80)]).doorSwing).toEqual(["reading-chair"]);
    expect(fit([chair(72)]).doorSwing).toEqual([]);
  });
  it("allows rugs over the swing and under furniture", () => {
    expect(fit([item({ kind: "rug", x: 250, z: 50, w: 90, d: 90 })]).passes).toBe(true);
    expect(fit([item(), item({ id: "rug", kind: "rug" })]).overlaps).toEqual([]);
  });
  it("reports overlaps beyond one centimetre", () => {
    expect(fit([item(), item({ id: "other", x: 129 })]).overlaps).toEqual([]);
    expect(fit([item(), item({ id: "other", x: 128.9 })]).overlaps).toEqual([["test", "other"]]);
  });
  it("swaps the footprint axes on quarter turns", () => {
    expect(footprintBounds(item({ w: 80, d: 30, rot: 90 }))).toEqual({ minX: 85, maxX: 115, minZ: 60, maxZ: 140 });
    expect(footprintBounds(item({ w: 80, d: 30, rot: 270 }))).toEqual(footprintBounds(item({ w: 80, d: 30, rot: 90 })));
  });
  it("has a clear default walkway to the desk chair", () => {
    const result = fit(owned());
    expect(result.walkway.targets).toEqual([{
      id: "desk-chair",
      target: { x: 312.5, z: 185 },
      reachable: true,
      pinch: [],
      path: [{ x: 262.5, z: 2.5 }, { x: 262.5, z: 137.5 }],
    }]);
    expect(result.passes).toBe(true);
  });
  it("reaches the front zone of a 58 cm chair at the reading chair anchor", () => {
    const reading = item({
      id: "reading-chair", kind: "chair", w: 58, d: 58,
      ...placeAtAnchor(SLOTS[0], { w: 58, d: 58, h: 80 }, []),
    });
    const result = fit([...owned(), reading]);
    expect(result.walkway.targets.find(target => target.id === reading.id)).toEqual({
      id: "reading-chair",
      target: { x: 308, z: 33 },
      reachable: true,
      pinch: [],
      path: [{ x: 262.5, z: 2.5 }],
    });
    expect(result.passes).toBe(true);
  });
  it("cannot reach the reading chair front zone behind a 90 cm deep bookshelf", () => {
    const reading = item({
      id: "reading-chair", kind: "chair", w: 58, d: 58,
      ...placeAtAnchor(SLOTS[0], { w: 58, d: 58, h: 80 }, []),
    });
    const layout = owned().map(entry => entry.id === "bookshelf"
      ? { ...entry, x: 270, z: 49, d: 90, rot: 0 as const } : entry);
    const result = fit([...layout, reading]);
    expect(result.overlaps).toEqual([]);
    expect(result.walkway.targets.find(target => target.id === reading.id)?.reachable).toBe(false);
    expect(result.passes).toBe(false);
  });
  it("reaches the desk chair from its front corners around the side table", () => {
    const reading = item({
      id: "reading-chair", kind: "chair", w: 63.5, d: 68.6,
      ...placeAtAnchor(SLOTS[0], { w: 63.5, d: 68.6, h: 80 }, []),
    });
    const table = item({ id: "side-table", x: 353.15, z: 96.35, w: 45.7, d: 45.7 });
    const result = fit([...owned(), reading, table]);
    expect(result.walkway.targets.find(target => target.id === "desk-chair")?.reachable).toBe(true);
  });
  it("fails when furniture closes the desk chair front and both front corners", () => {
    const blockers = [
      item({ id: "front-left", x: 263, z: 155, w: 40, d: 20 }),
      item({ id: "front-centre", x: 312, z: 155, w: 40, d: 20 }),
      item({ id: "front-right", x: 361, z: 155, w: 35, d: 20 }),
    ];
    const target = fit([...owned(), ...blockers]).walkway.targets.find(entry => entry.id === "desk-chair");
    expect(target?.reachable).toBe(false);
  });
  it("finds pinch cells when the bookshelf blocks the route", () => {
    const layout = owned().map(entry => entry.id === "bookshelf" ? { ...entry, x: 250, z: 85, rot: 0 as const } : entry);
    const result = fit(layout);
    expect(result.walkway.reachable).toBe(false);
    expect(result.walkway.pinch.length).toBeGreaterThan(0);
    expect(result.passes).toBe(false);
  });
  it("starts reachable target paths in the door opening and ends them in the chair front zone with straight runs only", () => {
    const layout = owned();
    const result = fit(layout);
    const reachable = result.walkway.targets.filter(t => t.reachable);
    expect(reachable.length).toBeGreaterThan(0);
    const inFrontZone = (targetChair: Footprint, p: { x: number; z: number }): boolean => {
      const box = footprintBounds(targetChair);
      const dirs: Record<number, { x: number; z: number }> = { 0: { x: 0, z: 1 }, 90: { x: 1, z: 0 }, 180: { x: 0, z: -1 }, 270: { x: -1, z: 0 } };
      const dir = dirs[targetChair.rot];
      const radius = dir.x === 0 ? (box.maxZ - box.minZ) / 2 : (box.maxX - box.minX) / 2;
      const centre = { x: targetChair.x + dir.x * (radius + 30), z: targetChair.z + dir.z * (radius + 30) };
      const halfW = dir.x === 0 ? (box.maxX - box.minX) / 2 + 30 : 30;
      const halfD = dir.z === 0 ? (box.maxZ - box.minZ) / 2 + 30 : 30;
      return p.x >= centre.x - halfW && p.x <= centre.x + halfW && p.z >= centre.z - halfD && p.z <= centre.z + halfD;
    };
    for (const target of reachable) {
      const path = target.path ?? [];
      expect(path.length).toBeGreaterThanOrEqual(1);
      const start = path[0];
      expect(start.x).toBeGreaterThanOrEqual(DOOR.opening.minX);
      expect(start.x).toBeLessThanOrEqual(DOOR.opening.maxX);
      expect(start.z).toBeLessThan(38);
      const chairItem = layout.find(entry => entry.id === target.id)!;
      const end = path[path.length - 1];
      expect(inFrontZone(chairItem, end)).toBe(true);
      for (let i = 0; i < path.length - 1; i++) {
        expect(path[i].x === path[i + 1].x || path[i].z === path[i + 1].z).toBe(true);
      }
    }
  });
  it("ends the blocked walkway path within 10 cm of a pinch cell when the bookshelf blocks the route", () => {
    const layout = owned().map(entry => entry.id === "bookshelf" ? { ...entry, x: 250, z: 85, rot: 0 as const } : entry);
    const result = fit(layout);
    expect(result.walkway.reachable).toBe(false);
    expect(result.passes).toBe(false);
    expect(result.messages).toContain("The walkway to the Desk chair is under 76 cm wide.");
    const blocked = result.walkway.targets.find(t => t.id === "desk-chair");
    expect(blocked?.reachable).toBe(false);
    const path = blocked?.path ?? [];
    expect(path.length).toBeGreaterThan(0);
    const end = path[path.length - 1];
    const distances = result.walkway.pinch.map(p => Math.hypot(p.x - end.x, p.z - end.z));
    expect(Math.min(...distances)).toBeLessThanOrEqual(10);
  });
  it("checks the reading chair approach and other obstacles on it", () => {
    const reading = item({ id: "reading-chair", x: 180, z: 150, kind: "chair", rot: 270 });
    expect(fit([reading]).walkway.reachable).toBe(true);
    expect(fit([reading, item({ id: "blocker", x: 120, z: 150 })]).walkway.reachable).toBe(false);
  });
  it("warns about tall furniture by the window without failing", () => {
    const result = fit([item({ id: "shelf", h: 180, x: 200, z: 290 })]);
    expect(result.window).toEqual(["shelf"]);
    expect(result.passes).toBe(true);
    expect(fit([item({ h: 90, x: 200, z: 290 })]).window).toEqual([]);
  });
  it("uses exact integer cents and counts slot prices only", () => {
    expect(fit([item(), ...owned()], { test: 10001, desk: 90000 }, 9999).budget).toEqual({ total: 10001, budget: 9999, over: 2 });
    expect(fit([item()], { test: 10001 }, 9999).passes).toBe(false);
    expect(() => fit([item()], { test: 1.5 }, 100)).toThrow("integer cents");
    expect(() => fit([item()], {}, -1)).toThrow("integer cents");
  });
  it("refuses locked, immovable, missing and invalid moves", () => {
    expect(moveItem(owned(), "desk", 200, 200, 0)).toHaveProperty("error");
    expect(moveItem([item({ movable: false })], "test", 200, 200, 0)).toHaveProperty("error");
    expect(moveItem([], "missing", 0, 0, 0)).toHaveProperty("error");
    expect(moveItem([item()], "test", NaN, 0, 0)).toHaveProperty("error");
  });
  it("moves and rotates the desk chair with an unlocked desk without mutating input", () => {
    const layout = owned().map(entry => ({ ...entry, locked: false }));
    const moved = moveItem(layout, "desk", 300, 275, 0);
    expect(Array.isArray(moved)).toBe(true);
    if (!Array.isArray(moved)) throw new Error(moved.error);
    expect(moved.find(entry => entry.id === "desk-chair")).toMatchObject({ x: 302.5, z: 212.5 });
    expect(layout[0].x).toBe(310);
    const turned = moveItem(layout, "desk", 310, 285, 90);
    if (!Array.isArray(turned)) throw new Error(turned.error);
    expect(turned[1].x).toBeCloseTo(247.5);
    expect(turned[1].z).toBeCloseTo(282.5);
    expect(turned[1].rot).toBe(270);
  });
  it("enforces the wall margin and all red findings", () => {
    expect(fit([item({ x: 17 })]).passes).toBe(true);
    expect(fit([item({ x: 16.9 })]).inside).toEqual(["test"]);
    expect(fit([item({ x: 16.9 })]).passes).toBe(false);
    expect(fit([item(), item({ id: "other" })]).passes).toBe(false);
    expect(fit([chair(90)]).passes).toBe(false);
    expect(fit([item({ x: NaN })]).passes).toBe(false);
  });
  it("reports unverified dimensions as a warning", () => {
    const result = fit([item({ dims: "unverified" })]);
    expect(result.unverified).toEqual(["test"]);
    expect(result.messages).toContain("The Test item has unverified dimensions.");
    expect(result.passes).toBe(true);
  });
  it("clips the circle to the swing quadrant", () => {
    expect(fit([item({ x: 180, z: 30 })]).doorSwing).toEqual([]);
    expect(fit([item({ x: 300, z: 75 })]).doorSwing).toEqual([]);
  });
  it("warns when pieces are tight to bring through the door", () => {
    expect(doorTight({ w: 86.4, d: 86.4 }, 80)).toEqual({ smallestCm: 86, openingCm: 80 });
    expect(doorTight({ w: 70, d: 90 }, 80)).toBeNull();
    expect(doorTight(null, 80)).toBeNull();

    const christopherKnight = item({
      id: "reading-chair",
      kind: "chair",
      w: 86.4,
      d: 86.4,
      h: 80,
      source: "slot",
      dims: "verified",
      x: 100,
      z: 100,
    });
    const rug = item({
      id: "rug",
      kind: "rug",
      w: 150,
      d: 210,
      h: 1,
      source: "slot",
      dims: "verified",
      x: 190,
      z: 150,
    });
    const standardChair = item({
      id: "reading-chair",
      kind: "chair",
      w: 60,
      d: 60,
      h: 80,
      source: "slot",
      dims: "verified",
      x: 100,
      z: 100,
    });

    const tightResult = fit([christopherKnight, rug]);
    expect(tightResult.tight).toEqual([{ id: "reading-chair", smallestCm: 86, openingCm: 80 }]);
    expect(tightResult.tight?.map(t => t.id)).not.toContain("rug");

    const standardResult = fit([standardChair, rug]);
    expect(standardResult.tight).toEqual([]);
    expect(tightResult.passes).toBe(standardResult.passes);
    expect(tightResult.messages).toEqual(standardResult.messages);
  });

  describe("evaluateDesignFit", () => {
    it("gives no geometric failure for an unsized reading chair in the door swing", () => {
      const chairInDoor = item({
        id: "reading-chair",
        label: "Reading chair",
        kind: "chair",
        source: "slot",
        dims: "unverified",
        nominal: true,
        w: 70,
        d: 70,
        h: 80,
        x: 250,
        z: 40,
        rot: 0,
      });
      const result = evaluateDesignFit([chairInDoor]);
      expect(result.doorSwing).toEqual([]);
      expect(result.unverified).toEqual(["reading-chair"]);
      expect(result.passes).toBe(true);
      expect(result.messages).toContain("Checks pass for sized items. One item is unverified.");
      expect(result.messages).toContain("The Reading chair has unverified dimensions.");
    });

    it("gives no geometric failure for an unsized floor lamp in the walkway", () => {
      const lampInWalkway = item({
        id: "floor-lamp",
        label: "Floor lamp",
        kind: "lamp",
        source: "slot",
        dims: "unverified",
        nominal: true,
        w: 40,
        d: 40,
        h: 150,
        x: 262.5,
        z: 70,
        rot: 0,
      });
      const result = evaluateDesignFit([...owned(), lampInWalkway]);
      expect(result.walkway.reachable).toBe(true);
      expect(result.unverified).toEqual(["floor-lamp"]);
      expect(result.passes).toBe(true);
      expect(result.messages).toContain("Checks pass for sized items. One item is unverified.");
      expect(result.messages).toContain("The Floor lamp has unverified dimensions.");
    });

    it("keeps the price of an unsized piece in the total and fails on budget when over", () => {
      const overBudgetChair = item({
        id: "reading-chair",
        label: "Reading chair",
        kind: "chair",
        source: "slot",
        dims: "unverified",
        nominal: true,
        w: 70,
        d: 70,
        h: 80,
        x: 341,
        z: 39,
        rot: 270,
      });
      const result = evaluateDesignFit([overBudgetChair], {
        prices: { "reading-chair": 50000 },
        budget: 40000,
      });
      expect(result.doorSwing).toEqual([]);
      expect(result.inside).toEqual([]);
      expect(result.overlaps).toEqual([]);
      expect(result.unverified).toEqual(["reading-chair"]);
      expect(result.budget).toEqual({ total: 50000, budget: 40000, over: 10000 });
      expect(result.passes).toBe(false);
      expect(result.messages).toContain("The basket is over budget by $100.00.");
      expect(result.messages).toContain("Checks pass for sized items. One item is unverified.");
      expect(result.messages).toContain("The Reading chair has unverified dimensions.");
    });
  });
});

