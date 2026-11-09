import type { Candidate, DesignView, QuoteLine, QuoteState, QuoteView, ReceiptView, RefundState, RefundView, SlotView } from "../shared/api-types";
import { SANDBOX_TEST_CARD } from "../paypal/client";
import type { PayPalGateway, PayPalResource, PayPalResult } from "../paypal/client";

export interface DesignSnapshot {
  id: string;
  version: number;
  slots: (Pick<SlotView, "slot" | "source" | "placement"> & {
    pick: Pick<Candidate, "id" | "title" | "priceCents" | "currency" | "url" | "domain"> | null;
  })[];
  fit: Pick<DesignView["fit"], "passes" | "unverified">;
}
export interface DesignReader {
  get(designId: string, visitor: string): Promise<DesignSnapshot | null>;
  applyPrices(designId: string, visitor: string, repriced: NonNullable<QuoteView['repriced']>, expectedVersion?: number): Promise<DesignView>;
}
export type CheckoutResult<T> = { ok: true; value: T; code?: "already_started" }
  | { ok: false; code: string; error: string; quote?: QuoteView; design?: DesignView };
export interface RecheckedLine { lineId: QuoteLine["lineId"]; priceCents: number | null }
export interface CheckoutOptions {
  method?: "paypal" | "card";
  recheck?: (lines: readonly QuoteLine[]) => Promise<readonly RecheckedLine[]>;
}
export interface CheckoutServiceOptions {
  db: D1Database;
  paypal: PayPalGateway;
  designs: DesignReader;
  returnUrl: string;
  cancelUrl: string;
  clock?: () => number;
  ids?: () => string;
}
interface QuoteRow {
  id: string; visitor: string; design_id: string; design_version: number; lines: string; total_cents: number;
  currency: string; hash: string; state: QuoteState; order_id: string | null; capture_id: string | null;
  captured_cents: number | null; refunded_cents: number; attempt: number; error: string | null;
  payment_method: "paypal" | "card";
  approve_url: string | null; repriced: string | null;
}
interface RefundRow {
  id: string; quote_id: string; line_id: string; amount_cents: number; state: RefundState; paypal_id: string | null;
}
interface EventRow { id: string; type: string; resource_id: string; custom_id: string }

const success = <T>(value: T): CheckoutResult<T> => ({ ok: true, value });
const failure = (code: string, error: string, quote?: QuoteView): Extract<CheckoutResult<never>, { ok: false }> => ({ ok: false, code, error, ...(quote ? { quote } : {}) });
const notFound = (): CheckoutResult<never> => failure("not_found", "This basket was not found.");
const dollars = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
const refundKey = (quoteId: string, lineId: string): string => JSON.stringify([quoteId, lineId]);
const approveLink = (body: { links?: { rel: string; href: string }[] }): string | undefined =>
  body.links?.find(link => link.rel === "payer-action")?.href ?? body.links?.find(link => link.rel === "approve")?.href;
const captures = (body: PayPalResource): PayPalResource[] => body.purchase_units?.flatMap(unit => unit.payments?.captures ?? []) ?? [];
const refunds = (body: PayPalResource): PayPalResource[] => [
  ...(body.refunds ?? []), ...(body.purchase_units?.flatMap(unit => unit.payments?.refunds ?? []) ?? []),
];
function cents(value: string | undefined): number | null {
  if (!value || !/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : null;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export async function quoteHash(lines: readonly QuoteLine[], version: number): Promise<string> {
  const bytes = new TextEncoder().encode(canonical({ lines, version }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export class CheckoutService {
  private readonly db: D1Database;
  private readonly paypal: PayPalGateway;
  private readonly clock: () => number;
  private readonly ids: () => string;
  constructor(private readonly options: CheckoutServiceOptions) {
    this.db = options.db;
    this.paypal = options.paypal;
    this.clock = options.clock ?? Date.now;
    this.ids = options.ids ?? (() => crypto.randomUUID());
  }
  private row(id: string): Promise<QuoteRow | null> {
    return this.db.prepare("SELECT * FROM quotes WHERE id = ?").bind(id).first<QuoteRow>();
  }
  private owned(id: string, visitor: string): Promise<QuoteRow | null> {
    return this.db.prepare("SELECT * FROM quotes WHERE id = ? AND visitor = ?").bind(id, visitor).first<QuoteRow>();
  }
  private view(row: QuoteRow): QuoteView {
    return {
      id: row.id, designId: row.design_id, designVersion: row.design_version,
      lines: JSON.parse(row.lines) as QuoteLine[], totalCents: row.total_cents, state: row.state,
      ...(row.approve_url ? { approveUrl: row.approve_url } : {}), ...(row.error ? { error: row.error } : {}),
      ...(row.repriced ? { repriced: JSON.parse(row.repriced) as QuoteView["repriced"] } : {}),
    };
  }
  private async current(id: string): Promise<QuoteView> { return this.view((await this.row(id))!); }

  async freezeQuote(designId: string, version: number, visitor: string): Promise<CheckoutResult<QuoteView>> {
    const design = await this.options.designs.get(designId, visitor);
    if (!design) return notFound();
    if (design.version !== version) return failure("design_changed", "Your room changed. Please make a new quote.");
    if (!design.fit.passes) return failure("fit_failed", "Fix the room checks before checkout.");
    const lines: QuoteLine[] = [];
    for (const slot of design.slots) {
      if (!slot.pick) continue;
      const pick = slot.pick;
      if (pick.currency !== "USD" || !Number.isSafeInteger(pick.priceCents) || pick.priceCents < 0) {
        return failure("invalid_price", "Every item needs a price in USD cents.");
      }
      lines.push({
        lineId: slot.slot, roomObjectId: slot.slot, productId: pick.id, title: pick.title.slice(0, 120),
        priceCents: pick.priceCents, currency: "USD", url: pick.url, domain: pick.domain,
        fitStatus: design.fit.unverified.includes(slot.slot) ? "unverified" : "fits", source: slot.source,
      });
    }
    if (!lines.length) return failure("empty_basket", "Pick at least one item before checkout.");
    lines.sort((a, b) => a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0);
    const total = lines.reduce((sum, line) => sum + line.priceCents, 0);
    if (!Number.isSafeInteger(total) || total <= 0) return failure("invalid_price", "The basket needs a valid total above zero.");
    const id = this.ids();
    const now = this.clock();
    await this.db.batch([
      this.db.prepare("UPDATE quotes SET state = 'superseded', updated_at = ? WHERE design_id = ? AND visitor = ? AND state = 'open'").bind(now, designId, visitor),
      this.db.prepare("UPDATE quotes SET state = 'superseded', error = ?, updated_at = ? WHERE design_id = ? AND visitor = ? AND state = 'approving'").bind("A newer quote replaced this one.", now, designId, visitor),
      this.db.prepare(`INSERT INTO quotes (id, visitor, design_id, design_version, lines, total_cents, currency, hash, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, 'open', ?, ?)`).bind(id, visitor, designId, version, JSON.stringify(lines), total, await quoteHash(lines, version), now, now),
    ]);
    return success(await this.current(id));
  }

  async startCheckout(quoteId: string, visitor: string, opts: CheckoutOptions = {}): Promise<CheckoutResult<QuoteView>> {
    const original = await this.owned(quoteId, visitor);
    if (!original) return notFound();
    if (original.attempt > 0 && original.state !== "cancelled" && original.payment_method !== (opts.method ?? "paypal")) {
      return failure("payment_method", "This quote already has a payment method. Freeze a new quote to change it.", this.view(original));
    }
    const checking = await this.db.prepare(`SELECT id FROM quotes WHERE design_id = ? AND visitor = ? AND (state IN ('capturing','capture_unknown') OR (id != ? AND state IN ('ordering','approving'))) LIMIT 1`)
      .bind(original.design_id, visitor, quoteId).first();
    if (checking) return failure("checking_payment", "PayPal is still checking this payment.", this.view(original));
    const changed = await this.db.prepare(`UPDATE quotes SET state = 'ordering',
      attempt = CASE WHEN state = 'cancelled' THEN attempt + 1 WHEN attempt = 0 THEN 1 ELSE attempt END,
      order_id = CASE WHEN state = 'cancelled' THEN NULL ELSE order_id END,
      approve_url = NULL, error = NULL, payment_method = ?, updated_at = ?
      WHERE id = ? AND visitor = ? AND (state IN ('open','cancelled') OR (state = 'approving' AND order_id IS NULL))
      AND NOT EXISTS (SELECT 1 FROM quotes AS other WHERE other.design_id = quotes.design_id AND other.visitor = quotes.visitor
        AND (other.state IN ('capturing','capture_unknown') OR (other.id != quotes.id AND other.state IN ('ordering','approving'))))`)
      .bind(opts.method ?? "paypal", this.clock(), quoteId, visitor).run();
    if (!changed.meta.changes) {
      const pending = await this.db.prepare("SELECT id FROM quotes WHERE design_id = ? AND visitor = ? AND (state IN ('capturing','capture_unknown') OR (id != ? AND state IN ('ordering','approving'))) LIMIT 1")
        .bind(original.design_id, visitor, quoteId).first();
      if (pending) return failure("checking_payment", "PayPal is still checking this payment.", await this.current(quoteId));
      return { ok: true, value: await this.current(quoteId), code: "already_started" };
    }
    const row = (await this.row(quoteId))!;
    const design = await this.options.designs.get(row.design_id, visitor);
    if (!design || design.version !== row.design_version) return this.stale(row, "design_changed", "Your room changed. Please make a new quote.");
    const lines = this.view(row).lines;
    let checked: readonly RecheckedLine[];
    try { checked = await (opts.recheck?.(structuredClone(lines)) ?? Promise.resolve([])); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Prices could not be checked. Please try again.";
      await this.db.prepare("UPDATE quotes SET state = 'open', error = ?, updated_at = ? WHERE id = ? AND state = 'ordering'")
        .bind(message, this.clock(), quoteId).run();
      if (error instanceof Error && 'status' in error) throw error;
      return failure("recheck_failed", message, await this.current(quoteId));
    }
    const repriced: NonNullable<QuoteView["repriced"]> = [];
    for (const entry of checked) {
      const line = lines.find(item => item.lineId === entry.lineId);
      if (line && entry.priceCents !== line.priceCents) {
        repriced.push({ lineId: line.lineId, oldCents: line.priceCents,
          newCents: entry.priceCents !== null && Number.isSafeInteger(entry.priceCents) && entry.priceCents >= 0 ? entry.priceCents : null });
      }
    }
    if (repriced.length) {
      let updated: DesignView;
      try { updated = await this.options.designs.applyPrices(row.design_id, visitor, repriced, row.design_version); }
      catch (error) {
        await this.db.prepare("UPDATE quotes SET state = 'open', updated_at = ? WHERE id = ? AND state = 'ordering'")
          .bind(this.clock(), quoteId).run();
        throw error;
      }
      const result = await this.stale(row, "price_changed", "Prices changed at the shop. Freeze a new quote.", repriced);
      return { ...result, design: updated };
    }
    const result = await this.paypal.createOrder(this.orderBody(row), `rw-order-${quoteId}-${row.attempt}`);
    if (row.payment_method === "card") {
      await this.cardAnswer(row, result);
      return success(await this.current(quoteId));
    }
    if (result.ok && result.body?.id) {
      await this.db.prepare("UPDATE quotes SET order_id = ?, approve_url = ?, state = 'approving', updated_at = ? WHERE id = ? AND state = 'ordering'")
        .bind(result.body.id, approveLink(result.body) ?? null, this.clock(), quoteId).run();
      return success(await this.current(quoteId));
    }
    const error = !result.ok && result.kind === "http"
      ? `${this.errorName(result)}: PayPal could not start this checkout.`
      : "Could not reach PayPal. No order was made that we know of.";
    await this.db.prepare("UPDATE quotes SET state = 'open', error = ?, updated_at = ? WHERE id = ? AND state = 'ordering'").bind(error, this.clock(), quoteId).run();
    return failure("order_failed", error, await this.current(quoteId));
  }

  private orderBody(row: QuoteRow): object {
    const lines = this.view(row).lines;
    return {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: "room", custom_id: `roomweft:${row.id}`, invoice_id: `RW-${row.id}-${row.attempt}`,
        description: "RoomWeft sandbox basket. No real goods are sold.", soft_descriptor: "ROOMWEFT",
        items: lines.map(line => ({ name: line.title, sku: line.roomObjectId,
          unit_amount: { currency_code: "USD", value: dollars(line.priceCents) }, quantity: "1", category: "PHYSICAL_GOODS" })),
        amount: { currency_code: "USD", value: dollars(row.total_cents), breakdown: { item_total: { currency_code: "USD", value: dollars(row.total_cents) } } },
      }],
      payment_source: row.payment_method === "card" ? { card: SANDBOX_TEST_CARD } : { paypal: { experience_context: {
        brand_name: "RoomWeft", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW",
        return_url: this.options.returnUrl, cancel_url: this.options.cancelUrl,
      } } },
    };
  }

  private async cardAnswer(row: QuoteRow, result: PayPalResult): Promise<void> {
    if (result.ok && result.body.id) {
      await this.db.prepare("UPDATE quotes SET order_id = ?, updated_at = ? WHERE id = ?")
        .bind(result.body.id, this.clock(), row.id).run();
      if (result.body.status === "COMPLETED" && await this.applyCapture(row, result.body)) return;
    }
    const declined = (!result.ok && result.kind === "http" && result.status === 422)
      || (result.ok && captures(result.body).some(capture => ["DECLINED", "DENIED"].includes(capture.status ?? "")));
    if (declined) {
      await this.db.prepare("UPDATE quotes SET state = 'declined', error = ?, updated_at = ? WHERE id = ? AND state != 'paid'")
        .bind("PayPal declined the test card. Your room is unchanged.", this.clock(), row.id).run();
    } else await this.markUnknown(row.id);
  }

  private async stale(row: QuoteRow, code: string, error: string, repriced?: QuoteView["repriced"]): Promise<Extract<CheckoutResult<never>, { ok: false }>> {
    await this.db.prepare("UPDATE quotes SET state = 'stale', error = ?, repriced = ?, updated_at = ? WHERE id = ? AND state = 'ordering'")
      .bind(error, repriced ? JSON.stringify(repriced) : null, this.clock(), row.id).run();
    return failure(code, error, await this.current(row.id));
  }
  private errorName(result: Extract<PayPalResult, { kind: "http" }>): string {
    const name = result.body?.name;
    return name && /^[A-Z_]{1,80}$/.test(name) ? name : "PAYPAL_ERROR";
  }
  private async unchanged(row: QuoteRow): Promise<boolean> {
    const design = await this.options.designs.get(row.design_id, row.visitor);
    return design?.version === row.design_version;
  }

  async completeReturn(orderId: string, visitor: string): Promise<CheckoutResult<ReceiptView>> {
    const row = await this.db.prepare("SELECT * FROM quotes WHERE order_id = ? AND visitor = ?").bind(orderId, visitor).first<QuoteRow>();
    if (!row) return notFound();
    if (row.state === "paid") return success(await this.buildReceipt(row));
    if (row.state === "capture_unknown") return this.reconcile(row.id);
    if (!(await this.unchanged(row))) {
      await this.db.prepare("UPDATE quotes SET state = 'superseded', error = ?, updated_at = ? WHERE id = ? AND state = 'approving'")
        .bind("Your room changed. Please make a new quote.", this.clock(), row.id).run();
      return failure("design_changed", "Your room changed. Please make a new quote.", await this.current(row.id));
    }
    const lock = await this.db.prepare("UPDATE quotes SET state = 'capturing', updated_at = ? WHERE id = ? AND state = 'approving'").bind(this.clock(), row.id).run();
    if (!lock.meta.changes) return success(await this.buildReceipt((await this.row(row.id))!));
    return this.capture(row, true);
  }

  private async capture(row: QuoteRow, recover: boolean): Promise<CheckoutResult<ReceiptView>> {
    const result = await this.paypal.captureOrder(row.order_id!, `rw-capture-${row.order_id}`);
    if (result.ok && await this.applyCapture(row, result.body)) return success(await this.buildReceipt((await this.row(row.id))!));
    if (!result.ok && result.kind === "http") {
      const issues = [result.body?.name, ...(result.body?.details?.map(detail => detail.issue) ?? [])];
      if (issues.includes("INSTRUMENT_DECLINED") || issues.includes("PAYER_ACTION_REQUIRED")) {
        await this.db.prepare("UPDATE quotes SET state = 'approving', approve_url = COALESCE(?, approve_url), error = ?, updated_at = ? WHERE id = ? AND state = 'capturing'")
          .bind(approveLink(result.body) ?? null, "PayPal declined the payment. Your room is unchanged.", this.clock(), row.id).run();
        return failure("payment_declined", "PayPal declined the payment. Your room is unchanged.", await this.current(row.id));
      }
      if (issues.includes("ORDER_ALREADY_CAPTURED")) {
        await this.markUnknown(row.id);
        return this.reconcile(row.id, false);
      }
    }
    await this.markUnknown(row.id);
    if (!result.ok && recover) return this.reconcile(row.id);
    return failure("checking_payment", "PayPal is still checking this payment.", await this.current(row.id));
  }
  private async markUnknown(id: string): Promise<void> {
    await this.db.prepare("UPDATE quotes SET state = 'capture_unknown', error = ?, updated_at = ? WHERE id = ? AND state IN ('ordering','approving','capturing','capture_unknown')")
      .bind("PayPal is still checking this payment.", this.clock(), id).run();
  }
  private async applyCapture(row: QuoteRow, order: PayPalResource): Promise<boolean> {
    const completed = captures(order).filter(capture => capture.status === "COMPLETED");
    const capture = completed[0];
    if (!capture?.id) return false;
    const amount = cents(capture.amount?.value);
    const mismatch = completed.length !== 1 || amount !== row.total_cents || capture.amount?.currency_code !== row.currency;
    await this.db.prepare("UPDATE quotes SET state = 'paid', capture_id = ?, captured_cents = ?, error = ?, updated_at = ? WHERE id = ?")
      .bind(capture.id, amount ?? 0, mismatch ? "amount_mismatch: PayPal reported a different payment amount or currency. Please check this receipt." : null, this.clock(), row.id).run();
    return true;
  }

  /** Internal recovery entry point. Public routes must check visitor ownership before calling it. */
  async reconcile(quoteId: string, retryCapture = true): Promise<CheckoutResult<ReceiptView>> {
    let row = await this.row(quoteId);
    if (!row) return notFound();
    if (!row.order_id && row.payment_method === "card" && row.state === "capture_unknown") {
      const result = await this.paypal.createOrder(this.orderBody(row), `rw-order-${row.id}-${row.attempt}`);
      await this.cardAnswer(row, result);
      row = (await this.row(quoteId))!;
      if (["paid", "declined"].includes(row.state)) return success(await this.buildReceipt(row));
    }
    if (!row.order_id) return failure("checking_payment", "PayPal is still checking this payment.", this.view(row));
    const order = await this.paypal.getOrder(row.order_id);
    if (!order.ok) return failure("checking_payment", "PayPal is still checking this payment.", this.view(row));
    if (await this.applyCapture(row, order.body)) return success(await this.buildReceipt((await this.row(quoteId))!));
    if (row.state === "paid") return success(await this.buildReceipt(row));
    if (!["approving", "capturing", "capture_unknown"].includes(row.state)) return success(await this.buildReceipt(row));
    if (captures(order.body).some(capture => capture.status === "DECLINED" || capture.status === "DENIED") || order.body.status === "VOIDED") {
      await this.db.prepare("UPDATE quotes SET state = 'declined', error = ?, updated_at = ? WHERE id = ? AND state != 'paid'")
        .bind("PayPal declined the payment. Your room is unchanged.", this.clock(), quoteId).run();
      return success(await this.buildReceipt((await this.row(quoteId))!));
    }
    if (retryCapture && order.body.status === "APPROVED" && captures(order.body).length === 0) {
      if (!(await this.unchanged(row))) {
        await this.db.prepare("UPDATE quotes SET state = 'superseded', error = ?, updated_at = ? WHERE id = ? AND state IN ('approving','capture_unknown')")
          .bind("Your room changed. Please make a new quote.", this.clock(), quoteId).run();
        return failure("design_changed", "Your room changed. Please make a new quote.", await this.current(quoteId));
      }
      const lock = await this.db.prepare("UPDATE quotes SET state = 'capturing', updated_at = ? WHERE id = ? AND state IN ('approving','capture_unknown')")
        .bind(this.clock(), quoteId).run();
      if (lock.meta.changes) return this.capture(row, false);
    }
    if (row.state !== "capturing") await this.markUnknown(quoteId);
    return failure("checking_payment", "PayPal is still checking this payment.", await this.current(quoteId));
  }

  async cancelReturn(orderId: string, visitor: string): Promise<CheckoutResult<QuoteView>> {
    const row = await this.db.prepare("SELECT * FROM quotes WHERE order_id = ? AND visitor = ?").bind(orderId, visitor).first<QuoteRow>();
    if (!row) return notFound();
    await this.db.prepare("UPDATE quotes SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'approving'").bind(this.clock(), row.id).run();
    return success(await this.current(row.id));
  }

  async refundLine(quoteId: string, lineId: string, visitor: string): Promise<CheckoutResult<RefundView>> {
    const quote = await this.owned(quoteId, visitor);
    if (!quote) return notFound();
    const existing = await this.db.prepare("SELECT * FROM refunds WHERE quote_id = ? AND line_id = ?").bind(quoteId, refundKey(quoteId, lineId)).first<RefundRow>();
    if (existing) return success(this.refundView(existing, lineId));
    if (quote.state !== "paid" || !quote.capture_id) return failure("not_paid", "This basket has no completed payment to refund.");
    if (quote.error?.startsWith("amount_mismatch")) return failure("amount_mismatch", "Check the payment amount before requesting a refund.");
    const line = this.view(quote).lines.find(item => item.lineId === lineId);
    if (!line) return notFound();
    if (line.priceCents <= 0) return failure("invalid_amount", "This item has no payment to refund.");
    const id = this.ids();
    const now = this.clock();
    const inserted = await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO refunds (id, quote_id, line_id, amount_cents, state, created_at, updated_at)
        SELECT ?, id, ?, ?, 'requesting', ?, ? FROM quotes
        WHERE id = ? AND state = 'paid' AND refunded_cents + ? <= captured_cents`)
        .bind(id, refundKey(quoteId, lineId), line.priceCents, now, now, quoteId, line.priceCents),
      this.db.prepare(`UPDATE quotes SET refunded_cents = refunded_cents + ?, updated_at = ?
        WHERE id = ? AND refunded_cents + ? <= captured_cents AND EXISTS (SELECT 1 FROM refunds WHERE id = ?)`)
        .bind(line.priceCents, now, quoteId, line.priceCents, id),
    ]);
    if (!inserted[0].meta.changes) {
      const first = await this.db.prepare("SELECT * FROM refunds WHERE quote_id = ? AND line_id = ?").bind(quoteId, refundKey(quoteId, lineId)).first<RefundRow>();
      return first ? success(this.refundView(first, lineId)) : failure("refund_limit", "This refund would exceed the payment left.");
    }
    const response = await this.paypal.refundCapture(quote.capture_id, {
      amount: { value: dollars(line.priceCents), currency_code: "USD" }, invoice_id: `RW-${quoteId}-R-${lineId}`,
      note_to_payer: `Refund for ${line.title}. Sandbox only.`,
    }, `rw-refund-${quote.capture_id}-${lineId}`);
    if (response.ok) await this.applyRefund(id, response.body);
    else if (response.kind === "http") await this.setRefund(id, "failed", null);
    else {
      await this.setRefund(id, "unknown", null);
      await this.recoverRefund(id);
    }
    return success(this.refundView((await this.refundRow(id))!, lineId));
  }
  private refundRow(id: string): Promise<RefundRow | null> {
    return this.db.prepare("SELECT * FROM refunds WHERE id = ?").bind(id).first<RefundRow>();
  }
  private refundView(row: RefundRow, lineId?: string): RefundView {
    return { id: row.id, quoteId: row.quote_id, lineId: lineId ?? (JSON.parse(row.line_id) as [string, string])[1], amountCents: row.amount_cents, state: row.state, paypalId: row.paypal_id };
  }
  private async setRefund(id: string, state: RefundState, paypalId: string | null): Promise<void> {
    const row = await this.refundRow(id);
    if (!row || row.state === "completed" || row.state === "failed") return;
    const statements: D1PreparedStatement[] = [];
    if (state === "failed") statements.push(this.db.prepare(`UPDATE quotes SET refunded_cents = refunded_cents - ?, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM refunds WHERE id = ? AND state NOT IN ('failed','completed'))`)
      .bind(row.amount_cents, this.clock(), row.quote_id, id));
    statements.push(this.db.prepare("UPDATE refunds SET state = ?, paypal_id = COALESCE(?, paypal_id), updated_at = ? WHERE id = ? AND state NOT IN ('failed','completed')")
      .bind(state, paypalId, this.clock(), id));
    await this.db.batch(statements);
  }
  private async applyRefund(id: string, resource: PayPalResource): Promise<void> {
    const state: RefundState = resource.id && resource.status === "COMPLETED" ? "completed"
      : resource.id && resource.status === "PENDING" ? "pending"
      : ["FAILED", "CANCELLED", "DENIED"].includes(resource.status ?? "") ? "failed" : "unknown";
    await this.setRefund(id, state, resource.id ?? null);
  }
  private async recoverRefund(id: string): Promise<boolean> {
    const refund = await this.refundRow(id);
    if (!refund) return false;
    const quote = await this.row(refund.quote_id);
    if (!quote?.capture_id || !quote.order_id) return false;
    const capture = await this.paypal.getCapture(quote.capture_id);
    const order = await this.paypal.getOrder(quote.order_id);
    const invoiceId = `RW-${quote.id}-R-${this.refundView(refund).lineId}`;
    const found = [...(capture.ok ? refunds(capture.body) : []), ...(order.ok ? refunds(order.body) : [])].find(item => item.invoice_id === invoiceId);
    if (!found?.id) return false;
    await this.applyRefund(id, found);
    return true;
  }

  /** Internal recovery entry point. A public refund lookup must first check its quote's visitor. */
  async refreshRefund(refundId: string): Promise<CheckoutResult<RefundView>> {
    let row = await this.refundRow(refundId);
    if (!row) return notFound();
    if (row.state === "completed" || row.state === "failed") return success(this.refundView(row));
    if (row.paypal_id) {
      const result = await this.paypal.getRefund(row.paypal_id);
      if (!result.ok) return failure("checking_refund", "PayPal is still checking this refund.");
      await this.applyRefund(refundId, result.body);
    } else if (!(await this.recoverRefund(refundId))) return failure("checking_refund", "PayPal is still checking this refund.");
    row = (await this.refundRow(refundId))!;
    return ["pending", "completed", "failed"].includes(row.state)
      ? success(this.refundView(row)) : failure("checking_refund", "PayPal is still checking this refund.");
  }

  private async buildReceipt(quote: QuoteRow): Promise<ReceiptView> {
    const rows = await this.db.prepare("SELECT * FROM refunds WHERE quote_id = ?").bind(quote.id).all<RefundRow>();
    const quoteView = this.view(quote);
    const lines: ReceiptView["lines"] = quoteView.lines.map(line => {
      const refund = rows.results.find(row => row.line_id === refundKey(quote.id, line.lineId));
      return { ...line, refund: refund ? { state: refund.state, amountCents: refund.amount_cents, paypalId: refund.paypal_id } : null };
    });
    const eventRows = await this.db.prepare(
      "SELECT type, received_at FROM webhook_events WHERE custom_id = ? ORDER BY received_at ASC LIMIT 10"
    ).bind(`roomweft:${quote.id}`).all<{ type: string; received_at: number }>();
    const events = eventRows.results.map(row => ({ type: row.type, receivedAt: row.received_at }));
    return { quote: quoteView, orderId: quote.order_id, captureId: quote.capture_id,
      capturedCents: quote.captured_cents ?? 0, refundedCents: quote.refunded_cents, lines,
      plan: quote.state === "paid" ? lines.map(line => ({ roomObjectId: line.roomObjectId, status: line.refund?.state === "completed" ? "returned" : "paid" })) : [],
      events,
      ...(quote.error?.startsWith("amount_mismatch") ? { amountMismatch: true } : {}),
    };
  }
  async receipt(quoteId: string, visitor: string, options: { reconcile?: boolean } = {}): Promise<CheckoutResult<ReceiptView>> {
    const quote = await this.owned(quoteId, visitor);
    if (!quote) return notFound();
    await this.processPendingEvents(quoteId);
    const current = (await this.row(quoteId))!;
    if (options.reconcile !== false && current.state === "capture_unknown") await this.reconcile(quoteId);
    const pending = await this.db.prepare("SELECT id FROM refunds WHERE quote_id = ? AND state IN ('requesting','pending','unknown')").bind(quoteId).all<{ id: string }>();
    for (const refund of pending.results) await this.refreshRefund(refund.id);
    return success(await this.buildReceipt((await this.row(quoteId))!));
  }

  /** Replays only verified, retained deliveries. Uncertain reads keep the row pending. */
  async processPendingEvents(quoteId?: string): Promise<void> {
    const events = await this.db.prepare(`SELECT * FROM webhook_events WHERE processed_at IS NULL${quoteId ? " AND custom_id = ?" : ""} ORDER BY received_at LIMIT 50`)
      .bind(...(quoteId ? [`roomweft:${quoteId}`] : [])).all<EventRow>();
    for (const event of events.results) {
      const id = event.custom_id.slice("roomweft:".length);
      let processed = false;
      if (event.type === "PAYMENT.CAPTURE.REFUNDED") {
        const known = await this.db.prepare("SELECT * FROM refunds WHERE quote_id = ? AND paypal_id = ?").bind(id, event.resource_id).first<RefundRow>();
        if (known) processed = (await this.refreshRefund(known.id)).ok;
        else {
          const unknown = await this.db.prepare("SELECT * FROM refunds WHERE quote_id = ? AND state IN ('requesting','unknown','pending')").bind(id).all<RefundRow>();
          for (const refund of unknown.results) {
            if (await this.recoverRefund(refund.id)) processed = (await this.refreshRefund(refund.id)).ok || processed;
          }
        }
      } else processed = (await this.reconcile(id)).ok;
      if (processed) await this.db.prepare("UPDATE webhook_events SET processed_at = ? WHERE id = ? AND processed_at IS NULL").bind(this.clock(), event.id).run();
    }
  }
}
