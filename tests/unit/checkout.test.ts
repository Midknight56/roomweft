import { describe, expect, it } from "vitest";
import { CheckoutService, quoteHash } from "../../src/checkout/service";
import { captureStep, completed, harness, orderBody, orderStep, readOrder, secondLine, unwrap } from "./checkout-helper";

describe("frozen checkout quotes", () => {
  it("freezes server prices, source records, unverified fit and a stable hash", async () => {
    const h = harness();
    h.design.fit.unverified = ["reading-chair"];
    h.design.slots[0].pick!.title = "c".repeat(150);
    const quote = await h.quote();
    expect(quote).toMatchObject({ state: "open", totalCents: 1250, designVersion: 1, lines: [{ lineId: "reading-chair", roomObjectId: "reading-chair", priceCents: 1250, fitStatus: "unverified", title: "c".repeat(120), source: h.design.slots[0].source }] });
    const row = h.db.sqlite.prepare("SELECT hash, currency FROM quotes WHERE id = ?").get(quote.id);
    expect(row).toMatchObject({ hash: await quoteHash(quote.lines, 1), currency: "USD" });
    expect(await quoteHash(quote.lines, 2)).not.toBe(row!.hash);
    h.design.slots[0].pick!.priceCents = 99999;
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).quote.totalCents).toBe(1250);
  });
  it("supersedes earlier open quotes of the same design", async () => {
    const h = harness();
    const first = await h.quote();
    const second = await h.quote();
    expect(unwrap(await h.service.receipt(first.id, "visitor")).quote.state).toBe("superseded");
    expect(second.state).toBe("open");
  });
  it("canonical hashes do not depend on source object keys or slot ordering", async () => {
    const h = harness();
    secondLine(h);
    const first = await h.quote();
    h.design.slots.reverse();
    const source = h.design.slots[0].source!;
    h.design.slots[0].source = { origin: source.origin, cached: source.cached, retrievedAt: source.retrievedAt, resultIds: source.resultIds, maxPrice: source.maxPrice, query: source.query };
    const second = await h.quote();
    const hashes = h.db.sqlite.prepare("SELECT hash FROM quotes WHERE id IN (?, ?)").all(first.id, second.id);
    expect(hashes[0].hash).toBe(hashes[1].hash);
  });
  it("returns not_found for a missing design or another visitor", async () => {
    const h = harness();
    expect(await h.service.freezeQuote("design", 1, "other")).toMatchObject({ ok: false, code: "not_found" });
    expect(await h.service.freezeQuote("missing", 1, "visitor")).toMatchObject({ ok: false, code: "not_found" });
  });
  it("rejects a changed version", async () => {
    const h = harness();
    expect(await h.service.freezeQuote("design", 0, "visitor")).toMatchObject({ ok: false, code: "design_changed" });
  });
  it("refuses a room with red fit results", async () => {
    const h = harness();
    h.design.fit.passes = false;
    expect(await h.service.freezeQuote("design", 1, "visitor")).toMatchObject({ ok: false, code: "fit_failed" });
  });
  it("omits slots with no search results and refuses an entirely empty basket", async () => {
    const h = harness();
    secondLine(h);
    h.design.slots[1].pick = null;
    expect((await h.quote()).lines).toHaveLength(1);
    h.design.slots[0].pick = null;
    expect(await h.service.freezeQuote("design", 1, "visitor")).toMatchObject({ ok: false, code: "empty_basket" });
  });
  it.each([[-1, "USD"], [1.2, "USD"], [100, "EUR"], [Number.MAX_SAFE_INTEGER + 1, "USD"], [0, "USD"]])("refuses invalid money %s %s", async (price, currency) => {
    const h = harness();
    h.design.slots[0].pick!.priceCents = price as number;
    h.design.slots[0].pick!.currency = currency as string;
    expect(await h.service.freezeQuote("design", 1, "visitor")).toMatchObject({ ok: false, code: "invalid_price" });
  });
});

describe("sandbox orders and captures", () => {
  it("success: ignores a tampered client total and builds the exact server basket", async () => {
    const h = harness();
    const quote = await h.quote();
    h.network.steps.push(orderStep(), captureStep());
    const input = { totalCents: 1, recheck: async () => [] };
    const started = unwrap(await h.service.startCheckout(quote.id, "visitor", input));
    expect(started.approveUrl).toBe("https://approve.test/order");
    const create = h.network.payments()[0];
    expect(create.headers.get("PayPal-Request-Id")).toBe(`rw-order-${quote.id}-1`);
    expect(create.body).toEqual({ intent: "CAPTURE", purchase_units: [{ reference_id: "room", custom_id: `roomweft:${quote.id}`, invoice_id: `RW-${quote.id}-1`, description: "RoomWeft sandbox basket. No real goods are sold.", soft_descriptor: "ROOMWEFT", items: [{ name: "Reading chair", sku: "reading-chair", unit_amount: { currency_code: "USD", value: "12.50" }, quantity: "1", category: "PHYSICAL_GOODS" }], amount: { currency_code: "USD", value: "12.50", breakdown: { item_total: { currency_code: "USD", value: "12.50" } } } }], payment_source: { paypal: { experience_context: { brand_name: "RoomWeft", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", return_url: "https://room.test/return", cancel_url: "https://room.test/cancel" } } } });
    const receipt = unwrap(await h.service.completeReturn("order", "visitor"));
    expect(receipt).toMatchObject({ quote: { state: "paid" }, orderId: "order", captureId: "capture", capturedCents: 1250, refundedCents: 0, plan: [{ roomObjectId: "reading-chair", status: "paid" }] });
    expect(h.network.payments()[1].headers.get("PayPal-Request-Id")).toBe("rw-capture-order");
    expect(unwrap(await h.service.completeReturn("order", "visitor"))).toEqual(receipt);
    expect(h.network.payments()).toHaveLength(2);
  });

  it("two checkout presses at once make one order and expose the saved approve link", async () => {
    const h = harness();
    const quote = await h.quote();
    h.network.steps.push(orderStep());
    const results = await Promise.all([h.service.startCheckout(quote.id, "visitor"), h.service.startCheckout(quote.id, "visitor")]);
    expect(results.some(result => result.ok && result.code === "already_started")).toBe(true);
    expect(h.network.payments()).toHaveLength(1);
    expect(await h.service.startCheckout(quote.id, "visitor")).toMatchObject({ ok: true, code: "already_started", value: { approveUrl: "https://approve.test/order" } });
  });
  it("two return loads capture once", async () => {
    const h = harness();
    await h.order();
    h.network.steps.push(captureStep());
    await Promise.all([h.service.completeReturn("order", "visitor"), h.service.completeReturn("order", "visitor")]);
    expect(h.network.payments().filter(call => call.path.endsWith("/capture"))).toHaveLength(1);
  });
  it("a checkout while another quote for the same design is capturing makes no new order", async () => {
    const h = harness();
    await h.order();
    const next = await h.quote();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    h.network.steps.push({ ...captureStep(), wait });
    const capturing = h.service.completeReturn("order", "visitor");
    for (let n = 0; n < 100 && !h.network.payments().some(call => call.path.endsWith("/capture")); n++) await Promise.resolve();
    try { expect(await h.service.startCheckout(next.id, "visitor")).toMatchObject({ ok: false, code: "checking_payment" }); }
    finally { release(); }
    unwrap(await capturing);
    expect(h.network.payments().filter(call => call.path === "/v2/checkout/orders")).toHaveLength(1);
  });
  it("accepts the approve relation when a payer action link is absent", async () => {
    const h = harness();
    const quote = await h.quote();
    h.network.steps.push({ ...orderStep(), body: { id: "order", links: [{ rel: "approve", href: "https://approve.test/fallback" }] } });
    expect(unwrap(await h.service.startCheckout(quote.id, "visitor")).approveUrl).toBe("https://approve.test/fallback");
  });
  it("cross visitor access is not_found before reading PayPal or changing a row", async () => {
    const h = harness();
    const quote = await h.order();
    const calls = h.network.calls.length;
    for (const result of [await h.service.startCheckout(quote.id, "other"), await h.service.completeReturn("order", "other"), await h.service.cancelReturn("order", "other"), await h.service.receipt(quote.id, "other"), await h.service.refundLine(quote.id, "reading-chair", "other")]) {
      expect(result).toMatchObject({ ok: false, code: "not_found" });
    }
    expect(h.network.calls).toHaveLength(calls);
  });
  it("cancelled approval leaves the design alone and a retry uses a new attempt", async () => {
    const h = harness();
    const quote = await h.order();
    const design = structuredClone(h.design);
    expect(unwrap(await h.service.cancelReturn("order", "visitor")).state).toBe("cancelled");
    expect(h.design).toEqual(design);
    expect(unwrap(await h.service.completeReturn("order", "visitor")).quote.state).toBe("cancelled");
    h.network.steps.push({ ...orderStep(), body: { ...orderBody, id: "order2" } });
    unwrap(await h.service.startCheckout(quote.id, "visitor"));
    expect(h.network.payments()[1].headers.get("PayPal-Request-Id")).toBe(`rw-order-${quote.id}-2`);
  });
  it.each(["INSTRUMENT_DECLINED", "PAYER_ACTION_REQUIRED"])("decline: %s preserves the quote and returns a recovery approve link", async issue => {
    const h = harness();
    await h.order();
    h.network.steps.push({ path: "/v2/checkout/orders/order/capture", status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue }], links: [{ rel: "payer-action", href: "https://approve.test/recover" }] } });
    expect(await h.service.completeReturn("order", "visitor")).toMatchObject({ ok: false, code: "payment_declined", quote: { state: "approving", approveUrl: "https://approve.test/recover", error: "PayPal declined the payment. Your room is unchanged." } });
    h.network.steps.push(captureStep());
    expect(unwrap(await h.service.completeReturn("order", "visitor")).quote.state).toBe("paid");
  });
  it("capture response lost after PayPal acted reconciles by GET and returns a receipt", async () => {
    const h = harness();
    await h.order();
    h.network.steps.push({ path: "/v2/checkout/orders/order/capture", lost: true }, readOrder(completed()));
    expect(unwrap(await h.service.completeReturn("order", "visitor")).quote.state).toBe("paid");
    expect(h.network.steps).toHaveLength(0);
  });
  it("an APPROVED order with no capture is retried once with the same capture request id", async () => {
    const h = harness();
    await h.order();
    h.network.steps.push({ path: "/v2/checkout/orders/order/capture", lost: true }, readOrder({ id: "order", status: "APPROVED" }), captureStep());
    expect(unwrap(await h.service.completeReturn("order", "visitor")).quote.state).toBe("paid");
    expect(h.network.payments().filter(call => call.path.endsWith("/capture")).map(call => call.headers.get("PayPal-Request-Id"))).toEqual(["rw-capture-order", "rw-capture-order"]);
  });
  it("capture still unknown blocks another checkout for the design, even with a new quote", async () => {
    const h = harness();
    const quote = await h.order();
    h.network.steps.push({ path: "/v2/checkout/orders/order/capture", lost: true }, readOrder({ status: "APPROVED" }), { path: "/v2/checkout/orders/order/capture", lost: true });
    expect(await h.service.completeReturn("order", "visitor")).toMatchObject({ ok: false, code: "checking_payment", quote: { state: "capture_unknown" } });
    const newQuote = await h.quote();
    const calls = h.network.calls.length;
    expect(await h.service.startCheckout(quote.id, "visitor")).toMatchObject({ code: "checking_payment" });
    expect(await h.service.startCheckout(newQuote.id, "visitor")).toMatchObject({ code: "checking_payment" });
    expect(h.network.calls).toHaveLength(calls);
    h.network.steps.push(readOrder(completed()));
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).quote.state).toBe("paid");
  });
  it("PENDING capture stays unknown without a second capture", async () => {
    const h = harness();
    await h.order();
    h.network.steps.push({ path: "/v2/checkout/orders/order/capture", body: { status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "capture", status: "PENDING" }] } }] } });
    expect(await h.service.completeReturn("order", "visitor")).toMatchObject({ code: "checking_payment", quote: { state: "capture_unknown" } });
    expect(h.network.payments()).toHaveLength(2);
  });
  it("ORDER_ALREADY_CAPTURED reconciles the authoritative order", async () => {
    const h = harness();
    await h.order();
    h.network.steps.push({ path: "/v2/checkout/orders/order/capture", status: 422, body: { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } }, readOrder(completed()));
    expect(unwrap(await h.service.completeReturn("order", "visitor")).captureId).toBe("capture");
  });
  it("ORDER_ALREADY_CAPTURED on the one capture retry reads again without another capture", async () => {
    const h = harness();
    await h.order();
    h.network.steps.push({ path: "/v2/checkout/orders/order/capture", lost: true }, readOrder({ status: "APPROVED" }),
      { path: "/v2/checkout/orders/order/capture", status: 422, body: { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } }, readOrder(completed()));
    expect(unwrap(await h.service.completeReturn("order", "visitor")).quote.state).toBe("paid");
    expect(h.network.payments().filter(call => call.path.endsWith("/capture"))).toHaveLength(2);
    expect(h.network.steps).toHaveLength(0);
  });
  it("formats integer cents exactly without floating point rounding", async () => {
    const h = harness();
    h.design.slots[0].pick!.priceCents = 9_007_199_254_740_990;
    const quote = await h.quote();
    h.network.steps.push(orderStep());
    unwrap(await h.service.startCheckout(quote.id, "visitor"));
    expect(h.network.payments()[0].body).toMatchObject({ purchase_units: [{ amount: { value: "90071992547409.90" }, items: [{ unit_amount: { value: "90071992547409.90" } }] }] });
  });
  it.each([["99.00", "USD"], ["12.50", "EUR"], ["invalid", "USD"]])("mismatched captured amount %s %s is paid with a visible flag", async (value, currency) => {
    const h = harness();
    const quote = await h.order();
    h.network.steps.push({ path: "/v2/checkout/orders/order/capture", body: completed(value, currency) });
    expect(unwrap(await h.service.completeReturn("order", "visitor"))).toMatchObject({ quote: { state: "paid", error: expect.stringContaining("amount_mismatch") }, amountMismatch: true });
    expect(await h.service.refundLine(quote.id, "reading-chair", "visitor")).toMatchObject({ code: "amount_mismatch" });
  });
  it("basket changed after order creation refuses capture", async () => {
    const h = harness();
    const quote = await h.order();
    h.design.version++;
    expect(await h.service.completeReturn("order", "visitor")).toMatchObject({ code: "design_changed", quote: { state: "superseded" } });
    expect(h.network.payments()).toHaveLength(1);
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).plan).toEqual([]);
  });
  it("recovery also refuses to capture an APPROVED order after the design changed", async () => {
    const h = harness();
    const quote = await h.order();
    h.design.version++;
    h.network.steps.push(readOrder({ status: "APPROVED" }));
    expect(await h.service.reconcile(quote.id)).toMatchObject({ code: "design_changed" });
    expect(h.network.payments()).toHaveLength(2);
  });
  it("a version change or removed design before checkout makes the quote stale", async () => {
    const h = harness();
    const quote = await h.quote();
    h.removeDesign();
    expect(await h.service.startCheckout(quote.id, "visitor")).toMatchObject({ code: "design_changed", quote: { state: "stale" } });
    expect(h.network.calls).toHaveLength(0);
  });
  it.each([1500, 1000, null])("price changed on recheck to %s requires a new quote and makes no order", async price => {
    const h = harness();
    const quote = await h.quote();
    expect(await h.service.startCheckout(quote.id, "visitor", { recheck: async () => [{ lineId: "reading-chair", priceCents: price }] }))
      .toMatchObject({ code: "price_changed", quote: { state: "stale", totalCents: 1250, repriced: [{ lineId: "reading-chair", oldCents: 1250, newCents: price }] } });
    expect(h.network.calls).toHaveLength(0);
  });
  it("a failed price recheck releases ordering without a PayPal call", async () => {
    const h = harness();
    const quote = await h.quote();
    expect(await h.service.startCheckout(quote.id, "visitor", { recheck: async () => { throw new Error("Test failure."); } }))
      .toMatchObject({ code: "recheck_failed", quote: { state: "open" } });
    expect(h.network.calls).toHaveLength(0);
  });
  it("lost order creation reads nothing and retries with the same request id after a service restart", async () => {
    const h = harness();
    const quote = await h.quote();
    h.network.steps.push({ path: "/v2/checkout/orders", lost: true }, orderStep());
    expect(await h.service.startCheckout(quote.id, "visitor")).toMatchObject({ code: "order_failed", quote: { state: "open", error: "Could not reach PayPal. No order was made that we know of." } });
    const restarted = new CheckoutService(h.options);
    expect(unwrap(await restarted.startCheckout(quote.id, "visitor")).state).toBe("approving");
    expect(h.network.payments().map(call => call.headers.get("PayPal-Request-Id"))).toEqual([`rw-order-${quote.id}-1`, `rw-order-${quote.id}-1`]);
    expect(h.network.payments().map(call => call.method)).toEqual(["POST", "POST"]);
  });
  it("HTTP create failure shows PayPal's name and permits retry", async () => {
    const h = harness();
    const quote = await h.quote();
    h.network.steps.push({ path: "/v2/checkout/orders", status: 422, body: { name: "UNPROCESSABLE_ENTITY" } }, orderStep());
    expect(await h.service.startCheckout(quote.id, "visitor")).toMatchObject({ code: "order_failed", quote: { state: "open", error: "UNPROCESSABLE_ENTITY: PayPal could not start this checkout." } });
    expect(unwrap(await h.service.startCheckout(quote.id, "visitor")).state).toBe("approving");
  });
  it("an uncertain reconciliation read keeps a capture unknown", async () => {
    const h = harness();
    const quote = await h.order();
    h.network.steps.push({ path: "/v2/checkout/orders/order/capture", lost: true }, { path: "/v2/checkout/orders/order", status: 503 });
    expect(await h.service.completeReturn("order", "visitor")).toMatchObject({ code: "checking_payment", quote: { state: "capture_unknown" } });
    h.network.steps.push(readOrder(completed()));
    expect(unwrap(await h.service.completeReturn("order", "visitor")).quote.state).toBe("paid");
    expect(await h.service.cancelReturn("missing", "visitor")).toMatchObject({ code: "not_found" });
    expect(await h.service.reconcile("missing")).toMatchObject({ code: "not_found" });
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).quote.state).toBe("paid");
  });
  it("reconciles a denied capture without retrying it", async () => {
    const h = harness();
    const quote = await h.order();
    h.network.steps.push(readOrder({ status: "COMPLETED", purchase_units: [{ payments: { captures: [{ status: "DENIED" }] } }] }));
    expect(unwrap(await h.service.reconcile(quote.id)).quote.state).toBe("declined");
    expect(h.network.payments()).toHaveLength(2);
  });
});
