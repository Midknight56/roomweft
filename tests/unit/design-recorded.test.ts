import { describe, expect, it } from 'vitest';
import { recordedRuns } from '../../src/design/recorded';
import { SLOTS, STYLES } from '../../src/shared/room';

describe('recorded searches',()=>{
  it('preserves all candidates in source order and capture provenance',()=>{
    let count=0;
    for (const style of STYLES) {
      const record=recordedRuns[style.id]; let latest=0;
      expect(record.style).toBe(style.id);
      for (const slot of SLOTS) {
        const built=record.slots[slot.id];
        expect(Array.isArray(built.candidates)).toBe(true);
        expect(built.resultIds).toEqual(built.candidates.map(c=>c.id));
        expect(built.query).toBeTruthy(); expect(built.maxPrice).toBeGreaterThan(0);
        for (const candidate of built.candidates) { expect(Number.isInteger(candidate.priceCents)).toBe(true); expect(candidate.currency).toBe('USD'); }
        latest=Math.max(latest,built.retrievedAt); count++;
      }
      expect(record.capturedAt).toBe(new Date(latest).toISOString());
    }
    expect(count).toBe(12);
  });
});
