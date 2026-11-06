import { describe, expect, it } from "vitest";
import { checkFit, footprintBounds, moveItem, type Footprint } from "../../src/shared/fit";
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
    expect(result.walkway.targets).toEqual([{ id: "desk-chair", target: { x: 312.5, z: 185 }, reachable: true, pinch: [] }]);
    expect(result.passes).toBe(true);
  });
  it("reaches the front zone of a 58 cm chair at the reading chair anchor", () => {
    const reading = item({
      id: "reading-chair", kind: "chair", w: 58, d: 58,
      ...placeAtAnchor(SLOTS[0], { w: 58, d: 58, h: 80 }, []),
    });
    const result = fit([...owned(), reading]);
    expect(result.walkway.targets.find(target => target.id === reading.id)).toEqual({
      id: "reading-chair", target: { x: 308, z: 33 }, reachable: true, pinch: [],
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
  it("finds pinch cells when the bookshelf blocks the route", () => {
    const layout = owned().map(entry => entry.id === "bookshelf" ? { ...entry, x: 250, z: 85, rot: 0 as const } : entry);
    const result = fit(layout);
    expect(result.walkway.reachable).toBe(false);
    expect(result.walkway.pinch.length).toBeGreaterThan(0);
    expect(result.passes).toBe(false);
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
});

