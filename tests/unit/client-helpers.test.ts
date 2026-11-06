import { describe, expect, it } from 'vitest';
import { approvalUrl, budgetText, checkoutAllowed, collides, fitBadge, layoutOf, money, paymentLocked, projectPoint, quoteChanged, refundText, restoredDesign, rotate, slotLabel, snap } from '../../src/client/helpers';
import type { DesignView, QuoteView } from '../../src/shared/api-types';
import { checkFit } from '../../src/shared/fit';
import type { Footprint, FitReport } from '../../src/shared/fit';
import { ROOM, DOOR, WINDOW } from '../../src/shared/room';

const fit = (): FitReport => checkFit([], ROOM, DOOR, WINDOW);
function design(): DesignView {
  return { id: 'room-one', version: 2, mode: 'recorded', style: 'warm-reading', budgetCents: 60000, owned: [], fit: fit(), totals: { totalCents: 40000, budgetCents: 60000, overCents: 0, unverifiedCount: 0 }, labels: { search: 'recorded', ai: 'recorded' }, slots: ['reading-chair', 'floor-lamp', 'side-table', 'rug'].map(slot => ({ slot: slot as DesignView['slots'][number]['slot'], pick: { id: slot, title: slot, priceCents: 10000, currency: 'USD', url: 'https://example.com/item', domain: 'example.com', colors: [], materials: [], dims: { w: 50, d: 55, h: 80 } }, placement: { x: 150, z: 160, rot: 90 }, by: 'rules', reason: 'Within the budget.', alternates: [], source: null })) };
}
const quote = (): QuoteView => ({ id: 'quote-one', designId: 'room-one', designVersion: 2, lines: [], totalCents: 40000, state: 'open' });
const obstacle: Footprint = { id: 'box', label: 'Chair', kind: 'chair', x: 150, z: 150, w: 100, d: 50, h: 80, rot: 0, locked: false, source: 'slot', dims: 'verified' };

describe('plan math', () => {
  it('draws each unsized slot with its nominal dimensions and server anchor',()=>{
    const value=design();
    value.slots.forEach(slot=>{slot.pick!.dims=null;slot.placement={x:341,z:39,rot:270,nominal:true};});
    const layout=layoutOf(value).filter(item=>item.source==='slot');
    expect(layout.map(({w,d,h})=>({w,d,h}))).toEqual([{w:70,d:70,h:80},{w:40,d:40,h:150},{w:45,d:45,h:55},{w:150,d:210,h:1}]);
    expect(layout.every(item=>item.nominal && item.dims==='unverified' && item.x===341 && item.z===39)).toBe(true);
  });
  it('snaps to the closest five centimetres, including negative coordinates', () => { expect(snap(103)).toBe(105); expect(snap(101)).toBe(100); expect(snap(-18)).toBe(-20); });
  it('rotates every quarter turn and wraps', () => { expect([rotate(0), rotate(90), rotate(180), rotate(270)]).toEqual([90, 180, 270, 0]); });
  it('keeps owned locks and server positions when building footprints', () => {
    const value = design(); value.owned = [{ id: 'desk', x: 280, z: 275, rot: 90, locked: false }]; const layout = layoutOf(value);
    expect(layout.find(item => item.id === 'desk')).toMatchObject({ x: 280, z: 275, rot: 90, locked: false, source: 'owned' });
    expect(layout.find(item => item.id === 'reading-chair')).toMatchObject({ w: 50, d: 55, h: 80, dims: 'verified', rot: 90 });
  });
  it('marks a size marker as unverified and leaves an empty slot out', () => { const value = design(); value.slots[0].pick!.dims = null; value.slots[1].pick = null; const layout = layoutOf(value); expect(layout.find(item => item.id === 'reading-chair')?.dims).toBe('unverified'); expect(layout.some(item => item.id === 'floor-lamp')).toBe(false); });
});
describe('walk collision', () => {
  it('keeps the eye circle inside every wall', () => { for (const point of [{ x: 24, z: 100 }, { x: 356, z: 100 }, { x: 100, z: 24 }, { x: 100, z: 296 }]) expect(collides(point, [])).toBe(true); expect(collides({ x: 25, z: 25 }, [])).toBe(false); });
  it('stops against a footprint and its clearance circle', () => { expect(collides({ x: 150, z: 150 }, [obstacle])).toBe(true); expect(collides({ x: 80, z: 150 }, [obstacle])).toBe(true); expect(collides({ x: 75, z: 150 }, [obstacle])).toBe(false); });
  it('uses rounded corners rather than an expanded square', () => { expect(collides({ x: 82, z: 107 }, [obstacle])).toBe(false); expect(collides({ x: 85, z: 110 }, [obstacle])).toBe(true); });
  it('uses rotated footprints', () => { expect(collides({ x: 150, z: 210 }, [obstacle])).toBe(false); expect(collides({ x: 150, z: 210 }, [{ ...obstacle, rot: 90 }])).toBe(true); });
  it('allows walking over a rug', () => { expect(collides({ x: 150, z: 150 }, [{ ...obstacle, kind: 'rug' }])).toBe(false); });
});
describe('thread projection', () => {
  const rect = { left: 16, top: 80, width: 600, height: 400 };
  it('maps the centre and corners to viewport coordinates', () => { expect(projectPoint({ x: 0, y: 0, z: 0 }, rect)).toEqual({ x: 316, y: 280 }); expect(projectPoint({ x: -1, y: 1, z: 0 }, rect)).toEqual({ x: 16, y: 80 }); expect(projectPoint({ x: 1, y: -1, z: 0 }, rect)).toEqual({ x: 616, y: 480 }); });
  it('hides offscreen and clipped objects', () => { for (const point of [{ x: 2, y: 0, z: 0 }, { x: 0, y: -2, z: 0 }, { x: 0, y: 0, z: 2 }, { x: 0, y: 0, z: -2 }]) expect(projectPoint(point, rect)).toBeNull(); });
});
describe('budget and fit copy', () => {
  it('uses integer cents for totals', () => { expect(money(28661)).toBe('$286.61'); expect(budgetText(30000, 60000)).toBe('$300.00 left in your budget'); expect(budgetText(60001, 60000)).toBe('$0.01 over budget'); expect(budgetText(60000, 60000)).toBe('$0.00 left in your budget'); });
  it('shows a passing badge', () => { expect(fitBadge(fit(), 'chair')).toEqual({ text: 'Fits', tone: 'moss' }); });
  it.each([
    ['inside', 'Outside the wall margin'], ['doorSwing', 'Blocks the door swing'], ['unverified', 'Fit unverified'], ['window', 'Blocks the window'],
  ] as const)('shows the %s finding', (key, text) => { const report = fit(); report[key] = ['chair']; expect(fitBadge(report, 'chair')).toEqual({ text, tone: key === 'inside' || key === 'doorSwing' ? 'alarm' : 'amber' }); });
  it('shows overlap and walkway failures', () => { const report = fit(); report.overlaps = [['chair', 'desk']]; expect(fitBadge(report, 'chair').text).toBe('Overlaps another item'); report.overlaps = []; report.walkway.targets = [{ id: 'chair', reachable: false, target: { x: 0, z: 0 }, pinch: [] }]; expect(fitBadge(report, 'chair')).toEqual({ text: 'Walkway under 76 cm', tone: 'alarm' }); });
  it('gives failures priority over unverified sizes', () => { const report = fit(); report.unverified = report.doorSwing = ['chair']; expect(fitBadge(report, 'chair').tone).toBe('alarm'); });
  it('uses room labels for slots', () => { expect(slotLabel('reading-chair')).toBe('Reading chair'); });
});
describe('quote and payment guards', () => {
  it.each([['pending', 'Refund pending'], ['requesting', 'Refund pending'], ['completed', 'Refund completed'], ['failed', 'Refund failed'], ['unknown', 'Checking refund']] as const)('shows the %s refund state', (state, text) => { expect(refundText(state)).toBe(text); });
  it('restores the same room only for its own receipt', () => { const raw = JSON.stringify({ quoteId: 'quote-one', design: design() }); expect(restoredDesign(raw, 'quote-one')).toEqual(design()); expect(restoredDesign(raw, 'another')).toBeNull(); for (const value of [null, '{}', 'invalid', 'null', JSON.stringify({ quoteId: 'quote-one', design: {} })]) expect(restoredDesign(value, 'quote-one')).toBeNull(); });
  it('accepts only a current open quote with all four picks and passing fit', () => { expect(checkoutAllowed(quote(), design())).toBe(true); const value = design(); value.fit.passes = false; expect(checkoutAllowed(quote(), value)).toBe(false); value.fit.passes = true; value.slots[0].pick = null; expect(checkoutAllowed(quote(), value)).toBe(false); value.slots = []; expect(checkoutAllowed(quote(), value)).toBe(false); });
  it('invalidates a quote after a move, swap, or a new design', () => { expect(quoteChanged(quote(), design())).toBe(false); expect(quoteChanged(quote(), { ...design(), version: 3 })).toBe(true); expect(quoteChanged(quote(), { ...design(), id: 'another' })).toBe(true); });
  it.each(['stale', 'superseded', 'capture_unknown', 'capturing', 'paid', 'ordering', 'declined', 'cancelled'] as const)('blocks payment in %s state', state => { expect(checkoutAllowed({ ...quote(), state }, design())).toBe(false); });
  it('blocks design edits during payment, but allows replacement after a sale', () => { expect(paymentLocked(null)).toBe(false); for (const state of ['ordering', 'approving', 'capturing', 'capture_unknown'] as const) expect(paymentLocked({ ...quote(), state })).toBe(true); expect(paymentLocked({ ...quote(), state: 'paid' })).toBe(false); });
  it('allows resuming an approval', () => { expect(checkoutAllowed({ ...quote(), state: 'approving' }, design())).toBe(true); });
  it('accepts only a sandbox buyer approval link', () => { expect(approvalUrl('https://www.sandbox.paypal.com/checkoutnow?token=test')).toBe('https://www.sandbox.paypal.com/checkoutnow?token=test'); for (const url of ['javascript:alert(1)', 'https://example.com/', 'https://www.sandbox.paypal.com.evil.test', 'http://www.sandbox.paypal.com', 'https://user:pass@www.sandbox.paypal.com', 'invalid']) expect(approvalUrl(url)).toBeNull(); });
});
