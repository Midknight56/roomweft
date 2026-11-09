import { describe, expect, it } from "vitest";
import { captureStep, completed, harness, orderStep, readOrder, secondLine, unwrap } from "./checkout-helper";

const refundPath = "/v2/payments/captures/capture/refund";
describe("sandbox line refunds", () => {
  it("refunds the frozen amount and marks the room object returned without changing the design", async () => {
    const h = harness();
    const quote = await h.paid();
    const design = structuredClone(h.design);
    h.design.slots[0].pick!.priceCents = 1;
    h.network.steps.push({ path: refundPath, status: 201, body: { id: "refund", status: "COMPLETED" } });
    const refund = unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"));
    expect(refund).toMatchObject({ quoteId: quote.id, lineId: "reading-chair", amountCents: 1250, state: "completed", paypalId: "refund" });
    const call = h.network.payments().at(-1)!;
    expect(call.body).toEqual({ amount: { value: "12.50", currency_code: "USD" }, invoice_id: `RW-${quote.id}-R-reading-chair`, note_to_payer: "Refund for Reading chair." });
    expect(call.headers.get("PayPal-Request-Id")).toBe("rw-refund-capture-reading-chair");
    const receipt = unwrap(await h.service.receipt(quote.id, "visitor"));
    expect(receipt).toMatchObject({ refundedCents: 1250, lines: [{ roomObjectId: "reading-chair", source: design.slots[0].source, refund: { state: "completed", amountCents: 1250 } }], plan: [{ roomObjectId: "reading-chair", status: "returned" }] });
    expect(h.design.version).toBe(1);
    expect(h.design.slots[0].pick).not.toBeNull();
  });
  it("partial refund repeated: two presses of one line make one PayPal call", async () => {
    const h = harness();
    const quote = await h.paid();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    h.network.steps.push({ path: refundPath, wait, body: { id: "refund", status: "COMPLETED" } });
    const first = h.service.refundLine(quote.id, "reading-chair", "visitor");
    // Wait for the reserved refund to reach the remote boundary before the second press.
    for (let n = 0; n < 100 && !h.network.payments().some(call => call.path === refundPath); n++) await Promise.resolve();
    expect(unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor")).state).toBe("requesting");
    release();
    const finished = unwrap(await first);
    expect(unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"))).toEqual(finished);
    expect(h.network.payments().filter(call => call.path === refundPath)).toHaveLength(1);
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).refundedCents).toBe(1250);
  });
  it("refuses a refund above the captured remainder before any PayPal call", async () => {
    const h = harness();
    secondLine(h);
    const quote = await h.order();
    h.network.steps.push({ ...captureStep(), body: completed("17.50") });
    unwrap(await h.service.completeReturn("order", "visitor"));
    h.db.sqlite.prepare("UPDATE quotes SET refunded_cents = 1000 WHERE id = ?").run(quote.id);
    const calls = h.network.calls.length;
    expect(await h.service.refundLine(quote.id, "reading-chair", "visitor")).toMatchObject({ ok: false, code: "refund_limit" });
    expect(h.network.calls).toHaveLength(calls);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM refunds").get()).toMatchObject({ n: 0 });
  });
  it("partial refunds reserve each line once and stop at the captured total", async () => {
    const h = harness();
    secondLine(h);
    const quote = await h.order();
    h.network.steps.push({ ...captureStep(), body: completed("17.50") });
    unwrap(await h.service.completeReturn("order", "visitor"));
    h.network.steps.push({ path: refundPath, body: { id: "refund-chair", status: "COMPLETED" } }, { path: refundPath, body: { id: "refund-lamp", status: "COMPLETED" } });
    const chair = unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"));
    const lamp = unwrap(await h.service.refundLine(quote.id, "floor-lamp", "visitor"));
    expect(chair.amountCents + lamp.amountCents).toBe(1750);
    expect(unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"))).toEqual(chair);
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).refundedCents).toBe(1750);
    expect(h.network.payments().filter(call => call.path === refundPath)).toHaveLength(2);
  });
  it("keeps each line's refund unique within its quote, across baskets", async () => {
    const h = harness();
    const first = await h.paid();
    h.network.steps.push({ path: refundPath, body: { id: "refund1", status: "COMPLETED" } });
    unwrap(await h.service.refundLine(first.id, "reading-chair", "visitor"));
    const next = await h.quote();
    h.network.steps.push({ ...orderStep(), body: { id: "order2" } }, { path: "/v2/checkout/orders/order2/capture", body: { ...completed(), id: "order2", purchase_units: [{ payments: { captures: [{ id: "capture2", status: "COMPLETED", amount: { value: "12.50", currency_code: "USD" } }] } }] } });
    unwrap(await h.service.startCheckout(next.id, "visitor"));
    unwrap(await h.service.completeReturn("order2", "visitor"));
    h.network.steps.push({ path: "/v2/payments/captures/capture2/refund", body: { id: "refund2", status: "COMPLETED" } });
    expect(unwrap(await h.service.refundLine(next.id, "reading-chair", "visitor")).paypalId).toBe("refund2");
  });
  it("refund pending then completed refreshes by the PayPal refund id", async () => {
    const h = harness();
    const quote = await h.paid();
    h.network.steps.push({ path: refundPath, body: { id: "refund", status: "PENDING" } });
    const refund = unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"));
    expect(refund.state).toBe("pending");
    h.network.steps.push({ path: "/v2/payments/refunds/refund", body: { id: "refund", status: "COMPLETED" } });
    expect(unwrap(await h.service.refreshRefund(refund.id)).state).toBe("completed");
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).refundedCents).toBe(1250);
  });
  it("refund failed releases the reserved cents exactly once and stays idempotent", async () => {
    const h = harness();
    const quote = await h.paid();
    h.network.steps.push({ path: refundPath, status: 422, body: { name: "UNPROCESSABLE_ENTITY" } });
    const refund = unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"));
    expect(refund.state).toBe("failed");
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).refundedCents).toBe(0);
    expect(unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor")).id).toBe(refund.id);
    await h.service.refreshRefund(refund.id);
    expect(h.network.payments().filter(call => call.path === refundPath)).toHaveLength(1);
  });
  it("a pending refund that later fails releases its reservation on receipt load", async () => {
    const h = harness();
    const quote = await h.paid();
    h.network.steps.push({ path: refundPath, body: { id: "refund", status: "PENDING" } });
    const refund = unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"));
    h.network.steps.push({ path: "/v2/payments/refunds/refund", body: { id: "refund", status: "FAILED" } });
    expect(unwrap(await h.service.receipt(quote.id, "visitor"))).toMatchObject({ refundedCents: 0, lines: [{ refund: { state: "failed" } }], plan: [{ status: "paid" }] });
    expect(unwrap(await h.service.refreshRefund(refund.id)).state).toBe("failed");
  });
  it("lost refund response reads capture and finds our invoice in the order refunds", async () => {
    const h = harness();
    const quote = await h.paid();
    h.network.steps.push({ path: refundPath, lost: true }, { path: "/v2/payments/captures/capture", body: { id: "capture" } }, readOrder({ purchase_units: [{ payments: { refunds: [{ id: "refund", invoice_id: `RW-${quote.id}-R-reading-chair`, status: "COMPLETED" }] } }] }));
    expect(unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"))).toMatchObject({ state: "completed", paypalId: "refund" });
    expect(h.network.steps).toHaveLength(0);
    expect(h.network.payments().some(call => call.path.includes("/refunds/"))).toBe(false);
  });
  it("lost refund with no discovered id stays unknown, reserves its cents and blocks a repeat", async () => {
    const h = harness();
    const quote = await h.paid();
    h.network.steps.push({ path: refundPath, lost: true }, { path: "/v2/payments/captures/capture", body: {} }, readOrder(completed()));
    const first = unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"));
    expect(first.state).toBe("unknown");
    const before = h.network.calls.length;
    expect(unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"))).toEqual(first);
    expect(h.network.calls).toHaveLength(before);
    expect(h.db.sqlite.prepare("SELECT refunded_cents FROM quotes WHERE id = ?").get(quote.id)).toMatchObject({ refunded_cents: 1250 });
  });
  it("failed refresh does not release an uncertain refund reservation", async () => {
    const h = harness();
    const quote = await h.paid();
    h.network.steps.push({ path: refundPath, body: { id: "refund", status: "PENDING" } });
    const refund = unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"));
    h.network.steps.push({ path: "/v2/payments/refunds/refund", lost: true });
    expect(await h.service.refreshRefund(refund.id)).toMatchObject({ ok: false, code: "checking_refund" });
    expect(h.db.sqlite.prepare("SELECT refunded_cents FROM quotes WHERE id = ?").get(quote.id)).toMatchObject({ refunded_cents: 1250 });
  });
  it("receipt recovers a refund left requesting across a restart", async () => {
    const h = harness();
    const quote = await h.paid();
    h.db.sqlite.prepare("INSERT INTO refunds (id, quote_id, line_id, amount_cents, state, created_at, updated_at) VALUES (?, ?, ?, 1250, 'requesting', 1, 1)").run("refund-row", quote.id, JSON.stringify([quote.id, "reading-chair"]));
    h.db.sqlite.prepare("UPDATE quotes SET refunded_cents = 1250 WHERE id = ?").run(quote.id);
    h.network.steps.push({ path: "/v2/payments/captures/capture", body: {} }, readOrder({ purchase_units: [{ payments: { refunds: [{ id: "refund", status: "COMPLETED", invoice_id: `RW-${quote.id}-R-reading-chair` }] } }] }));
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).lines[0].refund?.state).toBe("completed");
    expect(h.network.payments().filter(call => call.path === refundPath)).toHaveLength(0);
  });
  it("refuses a zero priced line without a PayPal call", async () => {
    const h = harness();
    secondLine(h);
    h.design.slots[1].pick!.priceCents = 0;
    const quote = await h.paid();
    const calls = h.network.calls.length;
    expect(await h.service.refundLine(quote.id, "floor-lamp", "visitor")).toMatchObject({ code: "invalid_amount" });
    expect(await h.service.refreshRefund("missing")).toMatchObject({ code: "not_found" });
    expect(h.network.calls).toHaveLength(calls);
  });
  it("refuses unpaid quotes and nonexistent lines", async () => {
    const h = harness();
    const quote = await h.quote();
    expect(await h.service.refundLine(quote.id, "reading-chair", "visitor")).toMatchObject({ code: "not_paid" });
    h.network.steps.push(orderStep(), captureStep());
    unwrap(await h.service.startCheckout(quote.id, "visitor"));
    unwrap(await h.service.completeReturn("order", "visitor"));
    const calls = h.network.calls.length;
    expect(await h.service.refundLine(quote.id, "missing", "visitor")).toMatchObject({ code: "not_found" });
    expect(h.network.calls).toHaveLength(calls);
  });
});
