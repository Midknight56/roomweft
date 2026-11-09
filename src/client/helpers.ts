import type { Candidate, DesignView, SlotView, QuoteView, ReceiptView, RefundState } from '../shared/api-types';
import type { Footprint, FitReport, Point, Rotation } from '../shared/fit';
import { footprintBounds } from '../shared/fit';
import { DEFAULT_ROOM_SPEC, NOMINAL_DIMS, OWNED_ITEMS, SLOTS, roomFromSpec, type RoomSpec } from '../shared/room';
import { roomModel } from './room-model';

export const snap = (value: number): number => Math.round(value / 5) * 5;
export const rotate = (value: Rotation): Rotation => ((value + 90) % 360) as Rotation;
export const money = (cents: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const budgetText = (total: number, budget: number): string => total > budget ? `${money(total - budget)} over budget` : `${money(budget - total)} left in your budget`;
export const unverifiedItemsText = (count: number): string => `${count} ${count === 1 ? 'item' : 'items'} with fit unverified`;
export const missingSizeText = (candidate: Candidate): string => candidate.hasMeasurements ? 'Size not usable from the listing' : 'Size not listed';
export const doorTightWarning = (tight: { smallestCm: number; openingCm: number } | null | undefined): string | null =>
  tight ? `${tight.smallestCm} cm at its narrowest, ${tight.openingCm} cm door: tight to bring in` : null;
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
  const owned: Footprint[] = roomFromSpec(design.roomSpec ?? DEFAULT_ROOM_SPEC).ownedItems.map(item => ({ ...item, ...design.owned.find(state => state.id === item.id), source: 'owned', dims: 'verified' }));
  const slots: Footprint[] = design.slots.flatMap(slot => {
    if (!slot.pick || !slot.placement) return [];
    const dims = slot.pick.dims ?? NOMINAL_DIMS[slot.slot];
    return [{ id: slot.slot, label: slot.pick.title, kind: slot.slot, ...slot.placement, ...dims, ...(!slot.pick.dims ? {nominal:true as const} : {}), locked: false, movable: true, source: 'slot' as const, dims: slot.pick.dims ? 'verified' as const : 'unverified' as const }];
  });
  return [...owned, ...slots];
}
export function collides(point: Point, layout: readonly Footprint[], radius = 25): boolean {
  if (point.x < radius || point.z < radius || point.x > roomModel().room.width - radius || point.z > roomModel().room.depth - radius) return true;
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
export interface FailedCheckSummary {
  count: number;
  objectId?: string;
  objectLabel?: string;
}
export function failedChecks(design: DesignView): FailedCheckSummary {
  const fit = design.fit;
  const failedObjectIds: string[] = [];
  if (fit.doorSwing?.length) {
    for (const id of fit.doorSwing) if (!failedObjectIds.includes(id)) failedObjectIds.push(id);
  }
  if (fit.inside?.length) {
    for (const id of fit.inside) if (!failedObjectIds.includes(id)) failedObjectIds.push(id);
  }
  if (fit.overlaps?.length) {
    for (const [a, b] of fit.overlaps) {
      if (!failedObjectIds.includes(a)) failedObjectIds.push(a);
      if (!failedObjectIds.includes(b)) failedObjectIds.push(b);
    }
  }
  const walkwayTargets = (fit.walkway?.targets ?? []).filter(t => !t.reachable);
  for (const t of walkwayTargets) {
    if (!failedObjectIds.includes(t.id)) failedObjectIds.push(t.id);
  }
  for (const slot of design.slots) {
    if (slot.pick && slot.unavailable && !failedObjectIds.includes(slot.slot)) {
      failedObjectIds.push(slot.slot);
    }
  }
  const overBudget = (fit.budget?.over > 0 || design.totals.overCents > 0) ? 1 : 0;
  let count = failedObjectIds.length + overBudget;
  if (!fit.passes && count === 0) count = 1;
  const firstId = failedObjectIds[0];
  const label = firstId ? (SLOTS.find(item => item.id === firstId)?.label ?? OWNED_ITEMS.find(item => item.id === firstId)?.label ?? firstId) : undefined;
  return { count, objectId: firstId, objectLabel: label };
}
export const refundText = (state: RefundState): string => state === 'unknown' ? 'Checking refund' : `Refund ${state === 'requesting' ? 'pending' : state}`;
export function paypalEventName(type: string): string {
  switch (type) {
    case 'CHECKOUT.ORDER.APPROVED':
      return 'Order approved';
    case 'PAYMENT.CAPTURE.COMPLETED':
      return 'Payment captured';
    case 'PAYMENT.CAPTURE.REFUNDED':
      return 'Refund completed';
    default:
      return type;
  }
}
export function eventTimeText(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
}
export function receiptStateText(state: QuoteView['state'], recorded = false): string {
  if (recorded) return 'Recorded sale, not paid';
  if (state === 'paid') return 'Paid in the PayPal sandbox';
  if (state === 'capturing' || state === 'capture_unknown') return 'Payment pending';
  if (state === 'declined') return 'Payment declined';
  return 'Not paid';
}
export const quoteChanged = (quote: QuoteView, design: DesignView): boolean => quote.designId !== design.id || quote.designVersion !== design.version || quote.state === 'stale' || quote.state === 'superseded';
export function paymentLocked(quote: QuoteView | null): boolean { return !!quote && ['ordering', 'approving', 'capturing', 'capture_unknown'].includes(quote.state); }
export function checkoutAllowed(quote: QuoteView, design: DesignView): boolean { return !quoteChanged(quote, design) && design.fit.passes && design.slots.some(slot => slot.pick) && ['open', 'approving'].includes(quote.state); }
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
export const shouldHidePhoneJump = (picksVisible: boolean, basketVisible: boolean): boolean => picksVisible || basketVisible;
export const isDesktopWidth = (width: number): boolean => width >= 700;
/** True when the room object shows as returned: a refunded line whose product is still the pick in that spot. */
export function returnedHere(receipt: ReceiptView | null, design: DesignView, objectId: string): boolean {
  const pick = design.slots.find(slot => slot.slot === objectId)?.pick?.id;
  return !!receipt?.plan.some(line => line.roomObjectId === objectId && line.status === 'returned' && (!line.productId || line.productId === pick));
}

/** The room spec the visitor typed: the design's spec with each edited field replaced. A blank field becomes NaN, so it fails validation. */
export function roomSpecFrom(base: RoomSpec, draft: Readonly<Record<string, string>>): unknown {
  const n = (field: string, fallback: number): number => draft[field] === undefined ? fallback : draft[field].trim() === '' ? Number.NaN : Number(draft[field]);
  const size = (id: string, value: RoomSpec['owned']['desk']) => ({ w: n(`size-${id}-w`, value.w), d: n(`size-${id}-d`, value.d), h: n(`size-${id}-h`, value.h) });
  return { width: n('width', base.width), depth: n('depth', base.depth), door: { left: n('door-left', base.door.left), width: n('door-width', base.door.width) },
    owned: { desk: size('desk', base.owned.desk), deskChair: size('desk-chair', base.owned.deskChair), bookshelf: size('bookshelf', base.owned.bookshelf) } };
}
