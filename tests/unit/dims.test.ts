import { describe, expect, it } from "vitest";
import { dimsFromOffer } from "../../src/shared/fit";

const measurement = (number: number, unit = "cm") => ({ number, unit });
const offer = (number: number, unit: string) => ({ width: measurement(number, unit), length: measurement(number, unit), height: measurement(number, unit) });

describe("offer dimensions", () => {
  it("converts inches to tenths of a centimetre", () => {
    expect(dimsFromOffer(offer(32.68, "in"))).toEqual({ w: 83, d: 83, h: 83 });
  });
  it.each([[2, "ft", 61], [500, "mm", 50], [0.5, "m", 50], [50, "cm", 50]])("converts %s %s", (value, unit, result) => {
    expect(dimsFromOffer(offer(value, unit))).toEqual({ w: result, d: result, h: result });
  });
  it("maps width to footprint width and length to depth, ignoring weight", () => {
    expect(dimsFromOffer({ width: measurement(50), length: measurement(70), height: measurement(90), weight: measurement(13154, "g") })).toEqual({ w: 50, d: 70, h: 90 });
  });
  it.each([
    ['Lorre', { length: measurement(84, 'in'), width: measurement(60, 'in'), height: measurement(0.4, 'in') }, { w: 152.4, d: 213.4, h: 1 }],
    ['Kruse', { length: measurement(84, 'in'), width: measurement(27, 'in'), height: measurement(84, 'in') }, { w: 68.6, d: 213.4, h: 1 }],
    ['Positano', { length: measurement(60, 'in'), width: measurement(0.25, 'in'), height: measurement(84, 'in') }, { w: 152.4, d: 213.4, h: 1 }],
    ['Supersoft', { length: measurement(6, 'ft'), width: measurement(4, 'ft'), height: measurement(0.4, 'in') }, { w: 121.9, d: 182.9, h: 1 }],
    ['Safavieh', { length: measurement(7.5, 'ft'), width: measurement(5.25, 'ft') }, { w: 160, d: 228.6, h: 1 }],
    ['Luna', { height: measurement(9, 'in') }, null],
  ])('reads %s rug axes from the listing', (_name, raw, expected) => {
    expect(dimsFromOffer(raw, 'rug')).toEqual(expected);
  });
  it('sorts the rug footprint, prefers length and width and enforces bounds', () => {
    expect(dimsFromOffer({ length: measurement(30), width: measurement(600), height: measurement(400) }, 'rug')).toEqual({ w: 30, d: 600, h: 1 });
    expect(dimsFromOffer({ length: measurement(29.9), width: measurement(600.1), height: measurement(80) }, 'rug')).toBeNull();
  });
  it.each([undefined, null, {}, { width: measurement(50), length: measurement(50) }, offer(0, "cm"), offer(1000, "in"), offer(Infinity, "cm"), offer(NaN, "cm"), offer(9.99, "cm"), offer(400.01, "cm"), offer(20, "yd"), offer(-50, "cm")])("rejects missing or invalid axes %#", dimensions => {
    expect(dimsFromOffer(dimensions)).toBeNull();
  });
  it("accepts exact bounds", () => {
    expect(dimsFromOffer(offer(10, "cm"))).not.toBeNull();
    expect(dimsFromOffer(offer(400, "cm"))).not.toBeNull();
  });
});
