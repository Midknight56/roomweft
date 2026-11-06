import type { PayPalGateway, PayPalResource } from "../paypal/client";
import type { CheckoutService } from "./service";

const eventTypes = new Set([
  "CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED",
]);
export interface WebhookOptions {
  db: D1Database;
  paypal: PayPalGateway;
  checkout: CheckoutService;
  webhookId: string;
  clock?: () => number;
}
interface WebhookEvent { id: string; event_type: string; resource: PayPalResource }

export class CheckoutWebhook {
  constructor(private readonly options: WebhookOptions) {}

  async handleWebhook(headers: Headers, rawBody: string): Promise<Response> {
    if (!(await this.options.paypal.verifyWebhook(headers, rawBody, this.options.webhookId))) return new Response(null, { status: 401 });
    let event: WebhookEvent;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid event.");
      event = parsed as WebhookEvent;
      if (typeof event.id !== "string" || !event.id || typeof event.event_type !== "string" || !event.resource || typeof event.resource !== "object" || Array.isArray(event.resource)) throw new Error("Invalid event.");
    } catch { return new Response(null, { status: 400 }); }
    if (!eventTypes.has(event.event_type)) {
      await this.options.checkout.processPendingEvents();
      return new Response(null, { status: 200 });
    }
    let customId = typeof event.resource.custom_id === "string" && event.resource.custom_id.startsWith("roomweft:") ? event.resource.custom_id : null;
    if (!customId && event.event_type === "CHECKOUT.ORDER.APPROVED" && Array.isArray(event.resource.purchase_units)) {
      customId = event.resource.purchase_units.find(unit => typeof unit?.custom_id === "string" && unit.custom_id.startsWith("roomweft:"))?.custom_id ?? null;
    }
    if (!customId && event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
      let captureId = event.resource.supplementary_data?.related_ids?.capture_id;
      if (!captureId && Array.isArray(event.resource.links)) {
        for (const link of event.resource.links) {
          if (typeof link?.href !== "string") continue;
          try {
            const match = /^\/v2\/payments\/captures\/([^/]+)$/.exec(new URL(link.href).pathname);
            if (match) { captureId = decodeURIComponent(match[1]); break; }
          } catch { /* Malformed links do not identify a local capture. */ }
        }
      }
      if (typeof captureId === "string") {
        const quote = await this.options.db.prepare("SELECT id FROM quotes WHERE capture_id = ?").bind(captureId).first<{ id: string }>();
        if (quote) customId = `roomweft:${quote.id}`;
      }
    }
    if (!customId) {
      await this.options.checkout.processPendingEvents();
      return new Response(null, { status: 200 });
    }
    const insert = await this.options.db.prepare(`INSERT OR IGNORE INTO webhook_events (id, type, resource_id, custom_id, received_at)
      VALUES (?, ?, ?, ?, ?)`).bind(event.id, event.event_type, typeof event.resource.id === "string" ? event.resource.id : null, customId, (this.options.clock ?? Date.now)()).run();
    if (!insert.meta.changes) return new Response(null, { status: 200 });
    await this.options.checkout.processPendingEvents();
    return new Response(null, { status: 200 });
  }
}
