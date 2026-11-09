import { describe, expect, it } from "vitest";
import { captureStep, completed, harness, secondLine, unwrap } from "./checkout-helper";
import { returnedHere } from "../../src/client/helpers";
import type { Candidate, ReceiptView } from "../../src/shared/api-types";
import type { SlotId } from "../../src/shared/room";
import type { DesignReader } from "../../src/checkout/service";

const refundPath = "/v2/payments/captures/capture/refund";
const ordersPath = "/v2/checkout/orders";
const slimChair: Candidate = { id: "product-chair-2", title: "Slim chair", colors: [], materials: [], dims: { w: 60, d: 60, h: 80 },
  priceCents: 900, currency: "USD", url: "https://shop.test/chair2", domain: "shop.test" };
const cardPaid = (id: string, value: string) => ({ path: ordersPath, body: { id, status: "COMPLETED",
  purchase_units: [{ payments: { captures: [{ id: `capture-${id}`, status: "COMPLETED", amount: { value, currency_code: "USD" } }] } }] } });

/** A paid two piece basket (chair and lamp) with the chair refunded, and a fake design side that swaps in the slim chair. */
async function returnedChair(opts: { refund?: "COMPLETED" | "PENDING"; noFit?: boolean } = {}) {
  const h = harness();
  secondLine(h);
  const quote = await h.order();
  h.network.steps.push({ ...captureStep(), body: completed("17.50") });
  unwrap(await h.service.completeReturn("order", "visitor"));
  h.network.steps.push({ path: refundPath, body: { id: "refund", status: opts.refund ?? "COMPLETED" } });
  unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"));
  const swaps: string[] = [];
  (h.options.designs as DesignReader).replace = async (id: string, visitor: string, slot: SlotId, exclude: string) => {
    if (id !== h.design.id || visitor !== "visitor") return null;
    const target = h.design.slots.find(item => item.slot === slot)!;
    if (target.pick && target.pick.id !== exclude) return structuredClone(h.design);
    if (opts.noFit) return null;
    swaps.push(exclude);
    target.pick = structuredClone(slimChair);
    h.design.version++;
    return structuredClone(h.design);
  };
  return { h, quote, swaps };
}
const stable = (receipt: ReceiptView) => ({ quote: receipt.quote, orderId: receipt.orderId, captureId: receipt.captureId,
  capturedCents: receipt.capturedCents, refundedCents: receipt.refundedCents, lines: receipt.lines, plan: receipt.plan, events: receipt.events });

describe("replace a returned piece with a one piece quote", () => {
  it("charges only the replacement, links it to the first receipt and leaves that receipt as it was", async () => {
    const { h, quote } = await returnedChair();
    const before = stable(unwrap(await h.service.receipt(quote.id, "visitor")));
    const replacement = unwrap(await h.service.replaceLine(quote.id, "reading-chair", "visitor"));
    expect(replacement).toMatchObject({ totalCents: 900, state: "open", designVersion: 2, replaces: { quoteId: quote.id, lineId: "reading-chair" } });
    expect(replacement.lines.map(line => [line.lineId, line.productId])).toEqual([["reading-chair", "product-chair-2"]]);
    h.network.steps.push(cardPaid("order-r", "9.00"));
    unwrap(await h.service.startCheckout(replacement.id, "visitor", { method: "card" }));
    const order = h.network.payments().filter(call => call.path === ordersPath).at(-1)!.body as { purchase_units: { items: { sku: string; unit_amount: { value: string } }[]; amount: { value: string } }[] };
    expect(order.purchase_units[0].items.map(item => [item.sku, item.unit_amount.value])).toEqual([["reading-chair", "9.00"]]);
    expect(order.purchase_units[0].amount.value).toBe("9.00");
    const paid = unwrap(await h.service.receipt(replacement.id, "visitor"));
    expect(paid).toMatchObject({ quote: { state: "paid", replaces: { quoteId: quote.id, lineId: "reading-chair" } }, capturedCents: 900 });
    expect(paid.lines).toHaveLength(1);
    expect(paid.plan).toEqual([{ roomObjectId: "reading-chair", productId: "product-chair-2", status: "paid" }]);
    const after = unwrap(await h.service.receipt(quote.id, "visitor"));
    expect(stable(after)).toEqual(before);
    expect(after.plan).toContainEqual({ roomObjectId: "reading-chair", productId: "product-chair", status: "returned" });
    expect(after.replacements).toEqual([{ lineId: "reading-chair", quoteId: replacement.id, state: "paid" }]);
  });
  it("a repeated request returns the same quote and PayPal sees one order for it", async () => {
    const { h, quote, swaps } = await returnedChair();
    const first = unwrap(await h.service.replaceLine(quote.id, "reading-chair", "visitor"));
    const again = unwrap(await h.service.replaceLine(quote.id, "reading-chair", "visitor"));
    expect(again.id).toBe(first.id);
    expect(swaps).toHaveLength(1);
    h.network.steps.push(cardPaid("order-r", "9.00"));
    unwrap(await h.service.startCheckout(first.id, "visitor", { method: "card" }));
    expect(unwrap(await h.service.replaceLine(quote.id, "reading-chair", "visitor")).id).toBe(first.id);
    expect((await h.service.startCheckout(first.id, "visitor", { method: "card" })).ok).toBe(true);
    expect(h.network.payments().filter(call => call.path === ordersPath)).toHaveLength(2);
  });
  it("freezes a fresh replacement when the first went stale, without swapping again", async () => {
    const { h, quote, swaps } = await returnedChair();
    const first = unwrap(await h.service.replaceLine(quote.id, "reading-chair", "visitor"));
    h.design.version++;
    h.network.steps.push(cardPaid("unused", "9.00"));
    expect(await h.service.startCheckout(first.id, "visitor", { method: "card" })).toMatchObject({ ok: false, code: "design_changed" });
    h.network.steps.length = 0;
    const next = unwrap(await h.service.replaceLine(quote.id, "reading-chair", "visitor"));
    expect(next.id).not.toBe(first.id);
    expect(next).toMatchObject({ state: "open", designVersion: 3, totalCents: 900 });
    expect(swaps).toHaveLength(1);
  });
  it("refuses a line whose refund has not completed", async () => {
    const { h, quote } = await returnedChair({ refund: "PENDING" });
    expect(await h.service.replaceLine(quote.id, "reading-chair", "visitor")).toMatchObject({ ok: false, code: "not_returned" });
    expect(await h.service.replaceLine(quote.id, "floor-lamp", "visitor")).toMatchObject({ ok: false, code: "not_returned" });
  });
  it("refuses another visitor", async () => {
    const { h, quote } = await returnedChair();
    expect(await h.service.replaceLine(quote.id, "reading-chair", "someone-else")).toMatchObject({ ok: false, code: "not_found" });
  });
  it("says so when no other piece fits", async () => {
    const { h, quote } = await returnedChair({ noFit: true });
    expect(await h.service.replaceLine(quote.id, "reading-chair", "visitor")).toMatchObject({ ok: false, code: "no_fit", error: "No other piece fits this spot right now." });
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM quotes").get()).toMatchObject({ n: 1 });
  });
  it("after the replacement is paid, the returned overlay is on the old product only", async () => {
    const { h, quote } = await returnedChair();
    const replacement = unwrap(await h.service.replaceLine(quote.id, "reading-chair", "visitor"));
    h.network.steps.push(cardPaid("order-r", "9.00"));
    unwrap(await h.service.startCheckout(replacement.id, "visitor", { method: "card" }));
    const first = unwrap(await h.service.receipt(quote.id, "visitor"));
    const design = structuredClone(h.design);
    expect(returnedHere(first, design, "reading-chair")).toBe(false);
    expect(returnedHere(first, design, "floor-lamp")).toBe(false);
    design.slots.find(slot => slot.slot === "reading-chair")!.pick!.id = "product-chair";
    expect(returnedHere(first, design, "reading-chair")).toBe(true);
  });
});
