import type { DesignView, SlotView, QuoteView, RefundState } from '../shared/api-types';
import type { Footprint, FitReport, Point, Rotation } from '../shared/fit';
import { footprintBounds } from '../shared/fit';
import { NOMINAL_DIMS, OWNED_ITEMS, ROOM, SLOTS } from '../shared/room';

export const snap = (value: number): number => Math.round(value / 5) * 5;
export const rotate = (value: Rotation): Rotation => ((value + 90) % 360) as Rotation;
export const money = (cents: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const budgetText = (total: number, budget: number): string => total > budget ? `${money(total - budget)} over budget` : `${money(budget - total)} left in your budget`;
export function fitBadge(fit: FitReport, id: string): { text: string; tone: 'alarm' | 'amber' | 'moss' } {
  if (fit.inside.includes(id)) return { text: 'Outside the wall margin', tone: 'alarm' };
  if (fit.doorSwing.includes(id)) return { text: 'Blocks the door swing', tone: 'alarm' };
  if (fit.overlaps.some(pair => pair.includes(id))) return { text: 'Overlaps another item', tone: 'alarm' };
  if (fit.walkway.targets.some(target => target.id === id && !target.reachable)) return { text: 'Walkway under 76 cm', tone: 'alarm' };
  if (fit.unverified.includes(id)) return { text: 'Fit unverified', tone: 'amber' };
  if (fit.window.includes(id)) return { text: 'Blocks the window', tone: 'amber' };
  return { text: 'Fits', tone: 'moss' };
}
export function layoutOf(design: DesignView): Footprint[] {
  const owned: Footprint[] = OWNED_ITEMS.map(item => ({ ...item, ...design.owned.find(state => state.id === item.id), source: 'owned', dims: 'verified' }));
  const slots: Footprint[] = design.slots.flatMap(slot => {
    if (!slot.pick || !slot.placement) return [];
    const dims = slot.pick.dims ?? NOMINAL_DIMS[slot.slot];
    return [{ id: slot.slot, label: slot.pick.title, kind: slot.slot, ...slot.placement, ...dims, ...(!slot.pick.dims ? {nominal:true as const} : {}), locked: false, movable: true, source: 'slot' as const, dims: slot.pick.dims ? 'verified' as const : 'unverified' as const }];
  });
  return [...owned, ...slots];
}
export function collides(point: Point, layout: readonly Footprint[], radius = 25): boolean {
  if (point.x < radius || point.z < radius || point.x > ROOM.width - radius || point.z > ROOM.depth - radius) return true;
  return layout.some(item => {
    if (item.kind === 'rug') return false;
    const box = footprintBounds(item);
    const x = Math.max(box.minX, Math.min(point.x, box.maxX));
    const z = Math.max(box.minZ, Math.min(point.z, box.maxZ));
    return (point.x - x) ** 2 + (point.z - z) ** 2 < radius ** 2;
  });
}
export function projectPoint(ndc: { x: number; y: number; z: number }, rect: { left: number; top: number; width: number; height: number }): { x: number; y: number } | null {
  if (ndc.z < -1 || ndc.z > 1 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return null;
  return { x: rect.left + (ndc.x + 1) * rect.width / 2, y: rect.top + (1 - ndc.y) * rect.height / 2 };
}
export const slotLabel = (slot: SlotView['slot']): string => SLOTS.find(item => item.id === slot)?.label ?? slot;
export const refundText = (state: RefundState): string => state === 'unknown' ? 'Checking refund' : `Refund ${state === 'requesting' ? 'pending' : state}`;
export const quoteChanged = (quote: QuoteView, design: DesignView): boolean => quote.designId !== design.id || quote.designVersion !== design.version || quote.state === 'stale' || quote.state === 'superseded';
export function paymentLocked(quote: QuoteView | null): boolean { return !!quote && ['ordering', 'approving', 'capturing', 'capture_unknown'].includes(quote.state); }
export function checkoutAllowed(quote: QuoteView, design: DesignView): boolean { return !quoteChanged(quote, design) && design.fit.passes && design.slots.length === 4 && design.slots.every(slot => slot.pick) && ['open', 'approving'].includes(quote.state); }
export function approvalUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'www.sandbox.paypal.com' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function restoredDesign(raw: string | null, quoteId: string): DesignView | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as { quoteId?: unknown; design?: DesignView };
    const value = saved.design;
    if (saved.quoteId !== quoteId || !value || typeof value.id !== 'string' || !Number.isSafeInteger(value.version)
      || !Array.isArray(value.owned) || !Array.isArray(value.slots) || !value.fit || !value.totals || !value.labels) return null;
    return value;
  } catch { return null; }
}
