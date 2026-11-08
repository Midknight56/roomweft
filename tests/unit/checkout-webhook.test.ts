import { describe, expect, it } from "vitest";
import { CheckoutWebhook } from "../../src/checkout/webhook";
import { asD1 } from "./d1-fake";
import { captureStep, completed, harness, readOrder, unwrap } from "./checkout-helper";

const headers = () => new Headers(Object.fromEntries(["auth-algo", "cert-url", "transmission-id", "transmission-sig", "transmission-time"].map(key => [`paypal-${key}`, `test-${key}`])));
function webhook(h: ReturnType<typeof harness>) {
  return new CheckoutWebhook({ db: asD1(h.db), paypal: h.paypal, checkout: h.service, webhookId: "test-webhook", clock: h.options.clock });
}
function verify(h: ReturnType<typeof harness>, status = "SUCCESS") {
  h.network.steps.push({ path: "/v1/notifications/verify-webhook-signature", body: { verification_status: status } });
}
const rawEvent = (quoteId: string, type = "PAYMENT.CAPTURE.COMPLETED", id = "event") => JSON.stringify({ id, event_type: type, resource: { id: "capture", custom_id: `roomweft:${quoteId}`, status: "COMPLETED" } });

describe("verified sandbox webhooks", () => {
  it("verifies card deliveries and reconciles their capture through the shared handler", async () => {
    const h = harness(); const quote = await h.quote();
    h.network.steps.push({ path: "/v2/checkout/orders", body: { id: "order", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "capture", status: "PENDING" }] } }] } });
    await h.service.startCheckout(quote.id, "visitor", { method: "card" });
    verify(h, "FAILURE");
    expect((await webhook(h).handleWebhook(headers(), rawEvent(quote.id))).status).toBe(401);
    expect(h.db.sqlite.prepare("SELECT state FROM quotes WHERE id = ?").get(quote.id)!.state).toBe("capture_unknown");
    verify(h); h.network.steps.push(readOrder(completed()));
    expect((await webhook(h).handleWebhook(headers(), rawEvent(quote.id))).status).toBe(200);
    expect(unwrap(await h.service.receipt(quote.id, "visitor"))).toMatchObject({ orderId: "order", captureId: "capture", quote: { state: "paid" } });
  });
  it("rejects a bad signature with 401 and stores nothing", async () => {
    const h = harness();
    verify(h, "FAILURE");
    expect((await webhook(h).handleWebhook(headers(), rawEvent("unknown"))).status).toBe(401);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()).toMatchObject({ n: 0 });
  });
  it("webhook duplicate is stored once and does no second reconciliation", async () => {
    const h = harness();
    const quote = await h.order();
    const handler = webhook(h);
    verify(h);
    h.network.steps.push(readOrder(completed()));
    expect((await handler.handleWebhook(headers(), rawEvent(quote.id))).status).toBe(200);
    verify(h);
    expect((await handler.handleWebhook(headers(), rawEvent(quote.id))).status).toBe(200);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()).toMatchObject({ n: 1 });
    expect(h.network.payments().filter(call => call.path === "/v2/checkout/orders/order")).toHaveLength(1);
    expect(h.db.sqlite.prepare("SELECT processed_at FROM webhook_events").get()!.processed_at).not.toBeNull();
  });
  it("webhook out of order reads PayPal and never downgrades a completed capture", async () => {
    const h = harness();
    const quote = await h.paid();
    verify(h);
    h.network.steps.push(readOrder(completed()));
    await webhook(h).handleWebhook(headers(), rawEvent(quote.id, "PAYMENT.CAPTURE.PENDING"));
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).quote.state).toBe("paid");
  });
  it("ignores other apps' events without storing or reading an order", async () => {
    const h = harness();
    verify(h);
    expect((await webhook(h).handleWebhook(headers(), JSON.stringify({ id: "foreign", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { custom_id: "other-app:quote", id: "capture" } }))).status).toBe(200);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()).toMatchObject({ n: 0 });
    expect(h.network.payments()).toHaveLength(1);
  });
  it("an APPROVED event reads the order before capturing with the stable request id", async () => {
    const h = harness();
    const quote = await h.order();
    verify(h);
    h.network.steps.push(readOrder({ status: "APPROVED" }), captureStep());
    await webhook(h).handleWebhook(headers(), rawEvent(quote.id, "CHECKOUT.ORDER.APPROVED"));
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).quote.state).toBe("paid");
    expect(h.network.payments().at(-1)!.headers.get("PayPal-Request-Id")).toBe("rw-capture-order");
  });
  it("finds an order approval's custom id in its purchase unit", async () => {
    const h = harness();
    const quote = await h.order();
    verify(h);
    h.network.steps.push(readOrder({ status: "APPROVED" }), captureStep());
    await webhook(h).handleWebhook(headers(), JSON.stringify({ id: "approval", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "order", purchase_units: [{ custom_id: `roomweft:${quote.id}` }] } }));
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).quote.state).toBe("paid");
  });
  it("does not downgrade a paid quote when a later order read has no completed capture", async () => {
    const h = harness();
    const quote = await h.paid();
    verify(h);
    h.network.steps.push(readOrder({ status: "APPROVED" }));
    await webhook(h).handleWebhook(headers(), rawEvent(quote.id, "PAYMENT.CAPTURE.DENIED"));
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).quote.state).toBe("paid");
    expect(h.network.payments().filter(call => call.path.endsWith("/capture"))).toHaveLength(1);
  });
  it("an event claiming completion cannot mark an uncertain payment paid", async () => {
    const h = harness();
    const quote = await h.order();
    verify(h);
    h.network.steps.push(readOrder({ status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "capture", status: "PENDING" }] } }] }));
    await webhook(h).handleWebhook(headers(), rawEvent(quote.id));
    expect(h.db.sqlite.prepare("SELECT state FROM quotes WHERE id = ?").get(quote.id)).toMatchObject({ state: "capture_unknown" });
    expect(h.db.sqlite.prepare("SELECT processed_at FROM webhook_events").get()!.processed_at).toBeNull();
  });
  it("unprocessed rows replay on receipt load after a failed PayPal read", async () => {
    const h = harness();
    const quote = await h.order();
    verify(h);
    h.network.steps.push({ path: "/v2/checkout/orders/order", lost: true });
    await webhook(h).handleWebhook(headers(), rawEvent(quote.id));
    expect(h.db.sqlite.prepare("SELECT processed_at FROM webhook_events").get()!.processed_at).toBeNull();
    h.tick();
    h.network.steps.push(readOrder(completed()));
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).quote.state).toBe("paid");
    expect(h.db.sqlite.prepare("SELECT processed_at FROM webhook_events").get()!.processed_at).not.toBeNull();
  });
  it("unprocessed rows replay on the next new event", async () => {
    const h = harness();
    const quote = await h.order();
    verify(h);
    h.network.steps.push({ path: "/v2/checkout/orders/order", lost: true });
    await webhook(h).handleWebhook(headers(), rawEvent(quote.id));
    verify(h);
    h.network.steps.push(readOrder(completed()), readOrder(completed()));
    await webhook(h).handleWebhook(headers(), rawEvent(quote.id, "PAYMENT.CAPTURE.DENIED", "event2"));
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE processed_at IS NULL").get()).toMatchObject({ n: 0 });
  });
  it.each(["related", "link"])("accepts a refund linked to our known capture by %s and refreshes PayPal", async kind => {
    const h = harness();
    const quote = await h.paid();
    h.network.steps.push({ path: "/v2/payments/captures/capture/refund", body: { id: "refund", status: "PENDING" } });
    unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"));
    verify(h);
    h.network.steps.push({ path: "/v2/payments/refunds/refund", body: { id: "refund", status: "COMPLETED" } });
    const relation = kind === "related" ? { supplementary_data: { related_ids: { capture_id: "capture" } } } : { links: [{ rel: "up", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/capture" }] };
    await webhook(h).handleWebhook(headers(), JSON.stringify({ id: "refund-event", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "refund", status: "FAILED", ...relation } }));
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).lines[0].refund?.state).toBe("completed");
  });
  it("a refund event resolves an earlier lost refund using the invoice id", async () => {
    const h = harness();
    const quote = await h.paid();
    h.network.steps.push({ path: "/v2/payments/captures/capture/refund", lost: true }, { path: "/v2/payments/captures/capture", body: {} }, readOrder(completed()));
    unwrap(await h.service.refundLine(quote.id, "reading-chair", "visitor"));
    verify(h);
    h.network.steps.push({ path: "/v2/payments/captures/capture", body: {} }, readOrder({ purchase_units: [{ payments: { refunds: [{ id: "refund", status: "PENDING", invoice_id: `RW-${quote.id}-R-reading-chair` }] } }] }), { path: "/v2/payments/refunds/refund", body: { id: "refund", status: "COMPLETED" } });
    await webhook(h).handleWebhook(headers(), JSON.stringify({ id: "refund-event", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "refund", supplementary_data: { related_ids: { capture_id: "capture" } } } }));
    expect(unwrap(await h.service.receipt(quote.id, "visitor")).plan[0].status).toBe("returned");
  });
  it("ignores an unknown capture refund and unsupported events", async () => {
    const h = harness();
    for (const type of ["PAYMENT.CAPTURE.REFUNDED", "UNRELATED.EVENT"]) {
      verify(h);
      expect((await webhook(h).handleWebhook(headers(), JSON.stringify({ id: type, event_type: type, resource: { id: "refund", supplementary_data: { related_ids: { capture_id: "unknown" } } } }))).status).toBe(200);
    }
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()).toMatchObject({ n: 0 });
  });
  it.each(["not json", "null", "{}", '{"id":"e","event_type":"PAYMENT.CAPTURE.COMPLETED"}'])("returns 400 for verified malformed input %s", async raw => {
    const h = harness();
    verify(h);
    expect((await webhook(h).handleWebhook(headers(), raw)).status).toBe(400);
  });
});
