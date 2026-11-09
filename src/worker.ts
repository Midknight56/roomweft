import type { Env } from './env';
import type { OwnedState, QuoteLine, StatusView } from './shared/api-types';
import { ROOM, DOOR, WINDOW, OWNED_ITEMS, STYLES, SLOTS, type SlotId } from './shared/room';
import type { Rotation } from './shared/fit';
import { DesignService, DesignError } from './design/service';
import { recordedRuns } from './design/recorded';
import { Channel3, takeCounter } from './products/channel3';
import { NeuronLedger, RESERVE } from './ai/ledger';
import { PayPalClient } from './paypal/client';
import { CheckoutService, type CheckoutResult, type RecheckedLine } from './checkout/service';
import { CheckoutWebhook } from './checkout/webhook';
import { CHECKOUTS_PER_DAY, LIVE_DESIGNS_PER_DAY, REFUNDS_PER_DAY, SEARCHES_PER_DAY, PRICE_MAX_AGE } from './limits';
import { HttpError, bodyText, jsonBody, numberField, stringField } from './http/request';
import { errorResponse, finish, visitorCookie } from './http/response';

export function services(env: Env) {
  const channel3 = new Channel3({ db: env.DB, apiKey: env.CHANNEL3_API_KEY });
  const ledger = new NeuronLedger(env.LEDGER);
  const designs = new DesignService({ db: env.DB, search: channel3, ledger, ai: env.AI });
  const paypal = new PayPalClient({ clientId: env.PAYPAL_CLIENT_ID ?? '', secret: env.PAYPAL_SECRET ?? '' });
  const checkout = new CheckoutService({ db: env.DB, paypal, designs: { get: async (id, visitor) => {
    try { return await designs.get(id, visitor); }
    catch (error) { if (error instanceof DesignError && error.code === 'not_found') return null; throw error; }
  }, applyPrices: (id, visitor, repriced, version) => designs.applyPrices(id, visitor, repriced, version) }, returnUrl: new URL('/return', env.PUBLIC_ORIGIN).href, cancelUrl: new URL('/cancel', env.PUBLIC_ORIGIN).href });
  const webhook = new CheckoutWebhook({ db: env.DB, paypal, checkout, webhookId: env.PAYPAL_WEBHOOK_ID ?? '' });
  return { channel3, ledger, designs, checkout, webhook, paypal };
}
type Services = ReturnType<typeof services>;
async function remaining(db: D1Database, key: string, cap: number, now: number): Promise<number> {
  const row = await db.prepare('SELECT n FROM counters WHERE key = ? AND day = ?').bind(key, new Date(now).toISOString().slice(0, 10)).first<{ n: number }>();
  return Math.max(0, cap - (row?.n ?? 0));
}
function serviceResponse<T>(result: CheckoutResult<T>): Response {
  if (result.ok) return Response.json(result.value);
  return Response.json({ error: result.error, code: result.code, ...(result.quote ? { quote: result.quote } : {}), ...(result.design ? { design: result.design } : {}) }, { status: result.code === 'not_found' ? 404 : 409 });
}
function rotation(body: Record<string, unknown>): Rotation {
  const value = numberField(body, 'rot');
  if (value !== 0 && value !== 90 && value !== 180 && value !== 270) throw new HttpError(400, 'invalid', 'Choose a right angle rotation.');
  return value;
}
function owned(body: Record<string, unknown>): OwnedState[] {
  if (!Array.isArray(body.owned)) throw new HttpError(400, 'invalid', 'Send the owned furniture.');
  return body.owned.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new HttpError(400, 'invalid', 'Send valid furniture.');
    const item = entry as Record<string, unknown>;
    if (typeof item.locked !== 'boolean') throw new HttpError(400, 'invalid', 'Send a lock state.');
    return { id: stringField(item, 'id'), x: numberField(item, 'x'), z: numberField(item, 'z'), rot: rotation(item), locked: item.locked };
  });
}
export async function recheckPrices(lines: readonly QuoteLine[], channel3: Pick<Channel3, 'product'>, now: number): Promise<{ checked: RecheckedLine[]; failed: boolean }> {
  const checked: RecheckedLine[] = [];
  let failed = false;
  for (const line of lines) {
    if (line.source && now - line.source.retrievedAt <= PRICE_MAX_AGE) continue;
    try {
      const result = await channel3.product(line.productId);
      if (!result.ok) { failed = true; continue; }
      const product = result.candidates.find(candidate => candidate.id === line.productId);
      checked.push({ lineId: line.lineId, priceCents: product?.priceCents ?? null });
    } catch { failed = true; }
  }
  return { checked, failed };
}

// Tests inject the service boundary while integration tests use the real local databases.
export function createWorker(makeServices: (env: Env) => Services = services, now: () => number = Date.now) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const visitor = visitorCookie(request);
      let response: Response;
      try { response = await route(request, env, visitor.id, makeServices, now()); }
      catch (error) {
        if (error instanceof HttpError) response = errorResponse(error.status, error.code, error.message);
        else if (error instanceof DesignError) response = errorResponse(error.code === 'not_found' ? 404 : error.code === 'changed' ? 409 : 400, error.code,
          error.code === 'not_found' ? 'This room was not found.' : error.code === 'changed' ? 'Your room changed. Please reload it.' : error.message);
        else response = errorResponse(500, 'unavailable', 'This request could not be completed. Please try again.');
      }
      return finish(response, visitor.cookie);
    },
  };
}
async function route(request: Request, env: Env, visitor: string, makeServices: (env: Env) => Services, now: number): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  const get = request.method === 'GET', post = request.method === 'POST';
  if (get && path === '/api/health') return Response.json({ ok: true });
  if (get && path === '/api/scenes') return Response.json({ room: ROOM, door: DOOR, window: WINDOW, owned: OWNED_ITEMS, styles: STYLES, slots: SLOTS, recorded: recordedRuns });
  if (!path.startsWith('/api/') && path !== '/return' && path !== '/cancel' && path !== '/webhooks/paypal') return env.ASSETS.fetch(request);
  const s = makeServices(env);
  if (get && path === '/api/status') {
    const [search, ai, designs, checkouts, refunds] = await Promise.all([
      remaining(env.DB, 'channel3', SEARCHES_PER_DAY, now), s.ledger.remaining(),
      remaining(env.DB, `design:${visitor}`, LIVE_DESIGNS_PER_DAY, now), remaining(env.DB, `checkout:${visitor}`, CHECKOUTS_PER_DAY, now), remaining(env.DB, `refund:${visitor}`, REFUNDS_PER_DAY, now),
    ]);
    return Response.json({ search: { live: !!env.CHANNEL3_API_KEY && search > 0, remainingToday: search },
      ai: { live: ai >= RESERVE, remainingNeuronsToday: ai }, sandbox: { live: !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET && env.PAYPAL_WEBHOOK_ID) },
      visitor: { liveDesignsLeft: designs, checkoutsLeft: checkouts, refundsLeft: refunds },
      ...(env.JUDGE_BUYER_EMAIL && env.JUDGE_BUYER_PASSWORD ? { judgeLogin: { email: env.JUDGE_BUYER_EMAIL, password: env.JUDGE_BUYER_PASSWORD } } : {}),
    } satisfies StatusView);
  }
  if (get && (path === '/return' || path === '/cancel')) {
    const token = url.searchParams.get('token');
    if (!token) throw new HttpError(400, 'invalid', 'Send the payment token.');
    const result = path === '/return' ? await s.checkout.completeReturn(token, visitor) : await s.checkout.cancelReturn(token, visitor);
    const target = new URL('/', request.url);
    if (path === '/cancel' && result.ok) target.searchParams.set('checkout', 'cancelled');
    else if (path === '/return' && result.ok && 'quote' in result.value && result.value.quote.state === 'paid') target.searchParams.set('receipt', result.value.quote.id);
    else {
      const state = result.ok ? ('quote' in result.value ? result.value.quote.state : result.value.state) : result.quote?.state ?? result.code;
      target.searchParams.set('checkout', state);
      target.searchParams.set('message', result.ok ? 'Payment has not completed. Your room is kept.' : result.error);
    }
    return Response.redirect(target.href, 303);
  }
  if (post && path === '/webhooks/paypal') {
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_SECRET || !env.PAYPAL_WEBHOOK_ID) throw new HttpError(503, 'sandbox_off', 'Sandbox payments are unavailable.');
    return s.webhook.handleWebhook(request.headers, await bodyText(request));
  }
  const receipt = /^\/api\/receipt\/([^/]+)$/.exec(path);
  if (get && receipt) return serviceResponse(await s.checkout.receipt(decodeURIComponent(receipt[1]), visitor));
  const designRoute = /^\/api\/design\/([^/]+)\/(swap|move|lock)$/.exec(path);
  if (!post || (!designRoute && !['/api/design', '/api/quote', '/api/checkout', '/api/refund'].includes(path))) return errorResponse(404, 'not_found', 'This route was not found.');
  const body = await jsonBody(request);
  if (path === '/api/design') {
    if (typeof body.live !== 'boolean') throw new HttpError(400, 'invalid', 'Choose live or recorded products.');
    if (body.brief !== undefined && typeof body.brief !== 'string') throw new HttpError(400, 'invalid', 'Use words for the room brief.');
    const design = await s.designs.createDesign({ brief: body.brief, style: stringField(body, 'style'), budget: numberField(body, 'budget'), owned: owned(body), live: body.live, visitorId: visitor });
    if (body.live && design.mode === 'recorded' && await remaining(env.DB, `design:${visitor}`, LIVE_DESIGNS_PER_DAY, now) === 0) {
      design.message = 'You have used all three live designs today. This is a recorded run.';
    }
    return Response.json(design);
  }
  if (designRoute) {
    const id = decodeURIComponent(designRoute[1]);
    if (designRoute[2] === 'swap') {
      const slot = stringField(body, 'slot');
      if (!SLOTS.some(s => s.id === slot)) throw new HttpError(400, 'invalid', 'Choose a known slot.');
      return Response.json(await s.designs.swap(id, visitor, slot as SlotId, stringField(body, 'productId')));
    }
    if (designRoute[2] === 'lock') {
      if (typeof body.locked !== 'boolean') throw new HttpError(400, 'invalid', 'Send a lock state.');
      return Response.json(await s.designs.setLock(id, visitor, stringField(body, 'itemId'), body.locked));
    }
    return Response.json(await s.designs.move(id, visitor, stringField(body, 'itemId'), numberField(body, 'x'), numberField(body, 'z'), rotation(body)));
  }
  if (path === '/api/quote') return serviceResponse(await s.checkout.freezeQuote(stringField(body, 'designId'), numberField(body, 'version'), visitor));
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_SECRET || !env.PAYPAL_WEBHOOK_ID) throw new HttpError(503, 'sandbox_off', 'Sandbox payments are unavailable.');
  const quoteId = stringField(body, 'quoteId');
  // Ownership and repeat attempts are checked before consuming a daily allowance.
  const quote = await env.DB.prepare('SELECT state FROM quotes WHERE id = ? AND visitor = ?').bind(quoteId, visitor).first<{ state: string }>();
  if (!quote) return errorResponse(404, 'not_found', 'This basket was not found.');
  if (path === '/api/refund') {
    const lineId = stringField(body, 'lineId');
    const prior = await env.DB.prepare('SELECT id FROM refunds WHERE quote_id = ? AND line_id = ?').bind(quoteId, JSON.stringify([quoteId, lineId])).first();
    if (!prior && !await takeCounter(env.DB, `refund:${visitor}`, REFUNDS_PER_DAY, now)) throw new HttpError(429, 'refund_cap', 'You have used all six refunds today. Please return tomorrow.');
    return serviceResponse(await s.checkout.refundLine(quoteId, lineId, visitor));
  }
  const method = body.method ?? 'paypal';
  if (method !== 'paypal' && method !== 'card') throw new HttpError(400, 'invalid', 'Choose a sandbox payment method.');
  if (['open', 'cancelled'].includes(quote.state) && !await takeCounter(env.DB, `checkout:${visitor}`, CHECKOUTS_PER_DAY, now)) throw new HttpError(429, 'checkout_cap', 'You have used all six checkouts today. Please return tomorrow.');
  const result = await s.checkout.startCheckout(quoteId, visitor, { method, recheck: async lines => {
    const recheck = await recheckPrices(lines, s.channel3, now);
    if (recheck.failed) {
      throw new HttpError(503, 'price_unchecked', 'We could not check a price with the shop just now. Nothing was charged. Please try again.');
    }
    return recheck.checked;
  } });
  if (method === 'card' && result.ok) return serviceResponse(await s.checkout.receipt(quoteId, visitor, { reconcile: false }));
  return serviceResponse(result);
}
export default createWorker() satisfies ExportedHandler<Env>;
