import { afterEach } from "vitest";
import { PayPalClient } from "../../src/paypal/client";
import { CheckoutService, type DesignSnapshot, type CheckoutResult } from "../../src/checkout/service";
import { asD1, freshD1, type FakeD1 } from "./d1-fake";

export interface Call { path: string; method: string; headers: Headers; raw: string; body: unknown }
export interface Step { path: string; status?: number; body?: unknown; lost?: boolean; wait?: Promise<void> }
export function scriptedFetch() {
  const calls: Call[] = [];
  const steps: Step[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const raw = typeof init?.body === "string" ? init.body : "";
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* OAuth bodies are form encoded. */ }
    calls.push({ path: url.pathname, method: init?.method ?? "GET", headers: new Headers(init?.headers), raw, body });
    if (url.pathname === "/v1/oauth2/token") return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }));
    const step = steps.shift();
    if (!step || step.path !== url.pathname) throw new Error(`Unexpected test call: ${url.pathname}`);
    if (step.wait) await step.wait;
    if (step.lost) throw new Error("Test connection lost.");
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200 });
  };
  return { calls, steps, fetcher, payments: () => calls.filter(call => call.path !== "/v1/oauth2/token") };
}
const databases: FakeD1[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.sqlite.close(); });

export function harness() {
  const db = freshD1();
  databases.push(db);
  const network = scriptedFetch();
  let now = 1_800_000_000_000;
  let nextId = 0;
  let design: DesignSnapshot | null = {
    id: "design", version: 1, fit: { passes: true, unverified: [] },
    slots: [{ slot: "reading-chair", placement: { x: 100, z: 100, rot: 0 },
      pick: { id: "product-chair", title: "Reading chair", priceCents: 1250, currency: "USD", url: "https://shop.test/chair", domain: "shop.test" },
      source: { query: "reading chair", maxPrice: 2000, resultIds: ["product-chair"], retrievedAt: now, cached: false, origin: "live" } }],
  };
  const paypal = new PayPalClient({ clientId: "test-client", secret: "test-only", fetch: network.fetcher, clock: () => now });
  const options = {
    db: asD1(db), paypal, designs: { get: async (id: string, visitor: string) => id === design?.id && visitor === "visitor" ? structuredClone(design) : null },
    returnUrl: "https://room.test/return", cancelUrl: "https://room.test/cancel", clock: () => now, ids: () => `id${++nextId}`,
  };
  const service = new CheckoutService(options);
  const h = {
    db, network, paypal, options, service,
    get design() { return design!; },
    set design(value: DesignSnapshot) { design = value; },
    removeDesign: () => { design = null; },
    tick: () => { now += 1000; },
    quote: async () => unwrap(await service.freezeQuote("design", design!.version, "visitor")),
    order: async () => {
      const quote = await h.quote();
      network.steps.push(orderStep());
      unwrap(await service.startCheckout(quote.id, "visitor"));
      return quote;
    },
    paid: async () => {
      const quote = await h.order();
      network.steps.push(captureStep());
      unwrap(await service.completeReturn("order", "visitor"));
      return quote;
    },
  };
  return h;
}
export function unwrap<T>(result: CheckoutResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}
export const orderBody = { id: "order", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://approve.test/order" }] };
export const orderStep = (): Step => ({ path: "/v2/checkout/orders", body: orderBody });
export const completed = (value = "12.50", currency = "USD") => ({ id: "order", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "capture", status: "COMPLETED", amount: { value, currency_code: currency } }] } }] });
export const captureStep = (): Step => ({ path: "/v2/checkout/orders/order/capture", status: 201, body: completed() });
export const readOrder = (body: unknown): Step => ({ path: "/v2/checkout/orders/order", body });
export function secondLine(h: ReturnType<typeof harness>): void {
  h.design.slots.push({ ...structuredClone(h.design.slots[0]), slot: "floor-lamp",
    pick: { ...h.design.slots[0].pick!, id: "product-lamp", title: "Floor lamp", priceCents: 500 } });
}
