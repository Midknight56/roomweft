import { describe, expect, it } from "vitest";
import { SANDBOX_TEST_CARD } from "../../src/paypal/client";
import { captureStep, completed, harness, readOrder, secondLine, unwrap } from "./checkout-helper";

const createPath = "/v2/checkout/orders";
describe("sandbox test card", () => {
  it("pays once with the frozen room lines, invoice and request id", async () => {
    const h = harness(); secondLine(h); const quote = await h.quote();
    h.network.steps.push({ path: createPath, status: 201, body: completed("17.50") });
    expect(unwrap(await h.service.startCheckout(quote.id, "visitor", { method: "card" })).state).toBe("paid");
    const receipt = unwrap(await h.service.receipt(quote.id, "visitor"));
    expect(receipt).toMatchObject({ orderId: "order", captureId: "capture", capturedCents: 1750, quote: { state: "paid" } });
    expect(receipt.lines.map(line => line.roomObjectId).sort()).toEqual(["floor-lamp", "reading-chair"]);
    const call = h.network.payments()[0];
    expect(call.headers.get("PayPal-Request-Id")).toBe(`rw-order-${quote.id}-1`);
    const body = call.body as { payment_source: object; purchase_units: { invoice_id: string; items: { sku: string }[] }[] };
    // Compare without including card data in assertion diagnostics.
    expect(JSON.stringify(body.payment_source) === JSON.stringify({ card: SANDBOX_TEST_CARD })).toBe(true);
    expect(body.purchase_units[0].invoice_id).toBe(`RW-${quote.id}-1`);
    expect(body.purchase_units[0].items.map(item => item.sku).sort()).toEqual(["floor-lamp", "reading-chair"]);
    expect(unwrap(await h.service.startCheckout(quote.id, "visitor", { method: "card" })).state).toBe("paid");
    expect(h.network.payments()).toHaveLength(1);
  });
  it.each(["http", "capture"])("stores a plain decline for %s", async mode => {
    const h = harness(); const quote = await h.quote();
    h.network.steps.push(mode === "http" ? { path: createPath, status: 422, body: { name: "UNPROCESSABLE_ENTITY" } }
      : { path: createPath, body: { id: "order", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ status: "DECLINED" }] } }] } });
    expect(unwrap(await h.service.startCheckout(quote.id, "visitor", { method: "card" }))).toMatchObject({ state: "declined", error: "PayPal declined the card. Your room is unchanged." });
  });
  it.each(["timeout", "server"])("recovers %s with the same create request id and then GET", async mode => {
    const h = harness(); const quote = await h.quote();
    h.network.steps.push(mode === "timeout" ? { path: createPath, lost: true } : { path: createPath, status: 503 });
    expect(unwrap(await h.service.startCheckout(quote.id, "visitor", { method: "card" })).state).toBe("capture_unknown");
    h.network.steps.push({ path: createPath, body: { id: "order", status: "CREATED" } }, readOrder(completed()));
    expect(unwrap(await h.service.reconcile(quote.id))).toMatchObject({ orderId: "order", captureId: "capture", quote: { state: "paid" } });
    expect(h.network.payments().slice(0, 2).map(call => call.headers.get("PayPal-Request-Id"))).toEqual([`rw-order-${quote.id}-1`, `rw-order-${quote.id}-1`]);
    expect(h.network.payments()[2].method).toBe("GET");
  });
  it("keeps a pending card attempt attached to its method and blocks a second quote", async () => {
    const h = harness(); const quote = await h.quote();
    h.network.steps.push({ path: createPath, lost: true });
    await h.service.startCheckout(quote.id, "visitor", { method: "card" });
    expect(await h.service.startCheckout(quote.id, "visitor")).toMatchObject({ ok: false, code: "payment_method" });
    const next = await h.quote();
    expect(await h.service.startCheckout(next.id, "visitor", { method: "card" })).toMatchObject({ ok: false, code: "checking_payment" });
    expect(unwrap(await h.service.receipt(quote.id, "visitor", { reconcile: false })).quote.state).toBe("capture_unknown");
    expect(h.network.payments()).toHaveLength(1);
  });
  it("supersedes an approving quote on freeze so a card can pay, and ignores a late PayPal return", async () => {
    const h = harness();
    const quoteA = await h.order();
    const quoteB = await h.quote();
    expect(unwrap(await h.service.receipt(quoteA.id, "visitor", { reconcile: false })).quote).toMatchObject({
      state: "superseded",
      error: "A newer quote replaced this one.",
    });
    h.network.steps.push({ path: createPath, status: 201, body: completed("12.50") });
    expect(unwrap(await h.service.startCheckout(quoteB.id, "visitor", { method: "card" })).state).toBe("paid");
    expect(unwrap(await h.service.receipt(quoteB.id, "visitor")).quote.state).toBe("paid");

    const paymentCalls = h.network.payments().length;
    await h.service.completeReturn("order", "visitor");
    expect(h.network.payments()).toHaveLength(paymentCalls);
    expect(unwrap(await h.service.receipt(quoteA.id, "visitor", { reconcile: false })).quote.state).toBe("superseded");
  });
  it("blocks a card order while another quote for that design is capturing", async () => {
    const h = harness();
    await h.order();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    h.network.steps.push({ ...captureStep(), wait });
    const capturing = h.service.completeReturn("order", "visitor");
    for (let n = 0; n < 100 && !h.network.payments().some(call => call.path.endsWith("/capture")); n++) await Promise.resolve();
    const next = await h.quote();
    try {
      expect(await h.service.startCheckout(next.id, "visitor", { method: "card" })).toMatchObject({ ok: false, code: "checking_payment" });
    } finally {
      release();
    }
    unwrap(await capturing);
  });
  it("uses ownership, version and price checks before sending a card", async () => {
    const h = harness(); const quote = await h.quote();
    expect(await h.service.startCheckout(quote.id, "other", { method: "card" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await h.service.startCheckout(quote.id, "visitor", { method: "card", recheck: async () => [{ lineId: "reading-chair", priceCents: 1 }] })).toMatchObject({ ok: false, code: "price_changed" });
    const next = await h.quote(); h.design.version++;
    expect(await h.service.startCheckout(next.id, "visitor", { method: "card" })).toMatchObject({ ok: false, code: "design_changed" });
    expect(h.network.payments()).toHaveLength(0);
  });
});
