import { describe, expect, it } from 'vitest';
import { recordedPicks, recordedRuns } from '../../src/design/recorded';
import { SLOTS, STYLES } from '../../src/shared/room';
import { withSlotDims } from '../../src/products/channel3';
import { validatePicks, type CandidateLists } from '../../src/ai/pick';
import { rulesPick } from '../../src/design/rules';

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
  it('the Calm studio saved run at $900 keeps four picks', () => {
    const calm = STYLES.find(s => s.id === 'calm-studio')!;
    const run = recordedRuns['calm-studio'];
    const lists = Object.fromEntries(SLOTS.map(s => [s.id, run.slots[s.id].candidates.map(c => withSlotDims(c, s.id))])) as unknown as CandidateLists;
    const input = { style: calm, budgetCents: 90000, candidates: lists };
    const stored = recordedPicks['calm-studio'];
    const savedPicks = stored ? validatePicks({ picks: Array.isArray(stored.picks) ? stored.picks.filter(p => (p as { by?: string }).by === 'ai') : [] }, input) : [];
    const picks = SLOTS.map(slot => {
      const chosen = savedPicks.find(p => p.slot === slot.id);
      return lists[slot.id].find(c => c.id === chosen?.id) ?? rulesPick(calm, 90000, slot.id, lists[slot.id]);
    });
    expect(picks.every(p => p !== null)).toBe(true);
    expect(picks).toHaveLength(4);
  });
});
