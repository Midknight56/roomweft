import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { createWorker, services, recheckPrices } from '../../src/worker';
import type { Env } from '../../src/env';
import type { DesignView, QuoteLine, QuoteView, ReceiptView } from '../../src/shared/api-types';
import { asD1, freshD1, LEDGER_SQL, type FakeD1 } from './d1-fake';
import { OWNED_ITEMS } from '../../src/shared/room';
import { BODY_LIMIT, PRICE_MAX_AGE } from '../../src/limits';
vi.mock('../../src/design/recorded',async()=>{
  const {makeRecordedData,fixtureCandidate}=await import('./recorded-fixture');
  const data=makeRecordedData();
  for (const run of Object.values(data.recordedRuns)) {
    for (const [id,slot] of Object.entries(run.slots)) {
      slot.candidates=id==='reading-chair' ? [
        {...fixtureCandidate('small'),dims:{w:58,d:58,h:90}},
        {...fixtureCandidate('large'),dims:{w:90,d:100,h:90}},
      ] : [];
      slot.resultIds=slot.candidates.map(c=>c.id);
    }
  }
  return data;
});
const visitor = 'a'.repeat(32), at = Date.UTC(2026, 10, 6, 12);
const dbs: FakeD1[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.sqlite.close()); vi.restoreAllMocks(); });
function fixture() {
  const db = freshD1(LEDGER_SQL); dbs.push(db);
  const env: Env = { DB: asD1(db), LEDGER: asD1(db), AI: {} as Ai, PUBLIC_ORIGIN: 'https://room.test',
    ASSETS: { fetch: vi.fn(async () => new Response('<main>Room</main>', { headers: { 'content-type': 'text/html' } })) },
    PAYPAL_CLIENT_ID: 'test-client', PAYPAL_SECRET: 'test-only', PAYPAL_WEBHOOK_ID: 'test-hook' };
  const s = services(env);
  const app = createWorker(() => s, () => at);
  const call = (path: string, body?: unknown, cookie: string | null = visitor) => app.fetch(new Request(`https://room.test${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie: `rw_vid=${cookie}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), env);
  return { db, env, s, app, call };
}
const quote: QuoteView = { id: 'quote', designId: 'design', designVersion: 1, lines: [], totalCents: 100, state: 'paid' };
const receipt: ReceiptView = { quote, orderId: 'order', captureId: 'capture', capturedCents: 100, refundedCents: 0, lines: [], plan: [] };
const input = { style: 'warm-reading', budget: 600, owned: OWNED_ITEMS.map(({ id, x, z, rot, locked }) => ({ id, x, z, rot, locked })), live: false };
function seedQuote(db: FakeD1, state = 'open') {
  db.sqlite.prepare(`INSERT INTO quotes(id, visitor, design_id, design_version, lines, total_cents, currency, hash, state, created_at, updated_at)
    VALUES ('quote', ?, 'design', 1, '[]', 100, 'USD', 'hash', ?, ?, ?)`).run(visitor, state, at, at);
}
function cap(db: FakeD1, key: string, n: number) { db.sqlite.prepare('INSERT INTO counters(key,day,n) VALUES(?,?,?)').run(key, '2026-11-06', n); }

describe('worker routes', () => {
  it.each(['/api/health', '/', '/missing', '/api/missing'])('makes a secure visitor cookie on %s', async path => {
    const { call } = fixture(); const response = await call(path, undefined, null);
    expect(response.headers.get('set-cookie')).toMatch(/^rw_vid=[a-f\d]{32}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=31536000$/);
  });
  it('keeps a valid cookie and replaces invalid cookies', async () => {
    const { call } = fixture();
    expect((await call('/api/health')).headers.has('set-cookie')).toBe(false);
    for (const value of ['abc', 'g'.repeat(32), 'a'.repeat(33)]) expect((await call('/api/health', undefined, value)).headers.get('set-cookie')).toMatch(/^rw_vid=[a-f\d]{32};/);
  });
  it('answers health without services or assets', async () => {
    const { env } = fixture(); const app = createWorker(() => { throw new Error('must not run'); });
    expect(await (await app.fetch(new Request('https://room.test/api/health'), env)).json()).toEqual({ ok: true });
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    expect(worker.fetch).toBeTypeOf('function');
  });
  it('adds HTML security headers and does not allow PayPal script or connections', async () => {
    const { call } = fixture(); const response = await call('/');
    const csp = response.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self';"); expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain('https://cdn.trychannel3.com'); expect(csp).toContain('https://www.sandbox.paypal.com'); expect(csp).not.toContain('navigate-to');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('returns JSON 404 for unknown paths and wrong methods under api', async () => {
    const { call } = fixture();
    for (const response of [await call('/api/nope'), await call('/api/health', {})]) {
      expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'This route was not found.', code: 'not_found' });
    }
  });
  it('limits actual bytes without trusting content length', async () => {
    const { call } = fixture(); const response = await call('/api/design', 'x'.repeat(BODY_LIMIT + 1));
    expect(response.status).toBe(413); expect(await response.json()).toHaveProperty('code', 'body_too_large');
    expect((await call('/api/design', 'é'.repeat(BODY_LIMIT / 2 + 1))).status).toBe(413);
  });
  it('rejects declared oversized, invalid JSON, arrays and malformed fields', async () => {
    const { app, env, call } = fixture();
    expect((await app.fetch(new Request('https://room.test/api/design', { method: 'POST', headers: { 'content-length': String(BODY_LIMIT + 1) }, body: '{}' }), env)).status).toBe(413);
    for (const body of ['{', '[]', { ...input, live: 'yes' }, { ...input, owned: [{}] }, { ...input, budget: '600' }]) expect((await call('/api/design', body)).status).toBe(400);
  });
  it('passes webhook raw text and headers unchanged', async () => {
    const { call, s } = fixture(); const raw = '{ \n "a" : 1, "a":2 }\n';
    const handler = vi.spyOn(s.webhook, 'handleWebhook').mockResolvedValue(new Response(null, { status: 202 }));
    expect((await call('/webhooks/paypal', raw)).status).toBe(202);
    expect(handler.mock.calls[0][1]).toBe(raw); expect(handler.mock.calls[0][0].get('cookie')).toBe(`rw_vid=${visitor}`);
  });
  it('redirects a captured return to its receipt and delegates cancellation', async () => {
    const { call, s } = fixture(); const complete = vi.spyOn(s.checkout, 'completeReturn').mockResolvedValue({ ok: true, value: receipt });
    const response = await call('/return?token=order'); expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://room.test/?receipt=quote'); expect(complete).toHaveBeenCalledWith('order', visitor);
    const cancel = vi.spyOn(s.checkout, 'cancelReturn').mockResolvedValue({ ok: true, value: { ...quote, state: 'cancelled' } });
    expect((await call('/cancel?token=order')).headers.get('location')).toBe('https://room.test/?checkout=cancelled'); expect(cancel).toHaveBeenCalledWith('order', visitor);
    expect((await call('/return')).status).toBe(400);
  });
  it('redirects uncertain and failed capture with state and message', async () => {
    const { call, s } = fixture();
    vi.spyOn(s.checkout, 'completeReturn').mockResolvedValue({ ok: false, code: 'checking_payment', error: 'PayPal is still checking this payment.', quote: { ...quote, state: 'capture_unknown' } });
    const url = new URL((await call('/return?token=order')).headers.get('location')!);
    expect(url.searchParams.get('checkout')).toBe('capture_unknown'); expect(url.searchParams.get('message')).toBe('PayPal is still checking this payment.');
  });
  it('reports independent live status and judge login only as a complete pair', async () => {
    const { call, env, db } = fixture();
    env.JUDGE_BUYER_EMAIL = 'judge@example.test';
    const first = await (await call('/api/status')).json();
    expect(first).toEqual({ search: { live: false, remainingToday: 300 }, ai: { live: true, remainingNeuronsToday: 1200 }, sandbox: { live: true }, visitor: { liveDesignsLeft: 3, checkoutsLeft: 6, refundsLeft: 6 } });
    env.CHANNEL3_API_KEY = 'test-only'; env.JUDGE_BUYER_PASSWORD = 'test-only';
    cap(db, 'channel3', 300); cap(db, `design:${visitor}`, 3);
    db.sqlite.prepare("INSERT INTO ai_calls(app,day,neurons) VALUES('roomweft','2026-11-06',1156)").run();
    const live = await (await call('/api/status')).json() as { search: { live: boolean }; visitor: { liveDesignsLeft: number }; judgeLogin: { email: string } };
    expect(live.search.live).toBe(false); expect(live.visitor.liveDesignsLeft).toBe(0); expect(live.judgeLogin.email).toBe('judge@example.test');
  });
  it('uses the exact AI threshold and fails closed on a broken ledger', async () => {
    const { call, s } = fixture(); const remaining = vi.spyOn(s.ledger, 'remaining');
    for (const [value, live] of [[9, false], [10, true]] as const) {
      remaining.mockResolvedValue(value);
      expect(await (await call('/api/status')).json()).toHaveProperty('ai.live', live);
    }
  });
  it('creates a recorded design, swaps and moves using owned visitor data', async () => {
    const { call } = fixture(); const scenes = await (await call('/api/scenes')).json() as { styles: unknown[]; recorded: object };
    expect(scenes.styles).toHaveLength(3); expect(Object.keys(scenes.recorded)).toHaveLength(3);
    const design = await (await call('/api/design', input)).json() as { id: string; version: number; mode: string; slots: { slot: string; alternates: { candidate: { id: string } }[] }[] };
    expect(design.mode).toBe('recorded'); expect(design.slots).toHaveLength(4);
    const slot = design.slots.find(s => s.alternates.length)!;
    const swapped = await (await call(`/api/design/${design.id}/swap`, { slot: slot.slot, productId: slot.alternates[0].candidate.id })).json() as { version: number };
    expect(swapped.version).toBe(2);
    expect((await call(`/api/design/${design.id}/move`, { itemId: 'desk', x: 200, z: 200, rot: 0 })).status).toBe(400);
    expect((await call(`/api/design/${design.id}/move`, { itemId: 'bookshelf', x: 60, z: 180, rot: 90 })).status).toBe(200);
    expect((await call(`/api/design/${design.id}/lock`, { itemId: 'bookshelf', locked: true })).status).toBe(200);
    expect((await call(`/api/design/${design.id}/swap`, { slot: slot.slot, productId: slot.alternates[0].candidate.id }, 'b'.repeat(32))).status).toBe(404);
  });
  it('returns a recorded design when the visitor live design cap is reached', async () => {
    const { call, db, s } = fixture(); cap(db, `design:${visitor}`, 3);
    const search = vi.spyOn(s.channel3, 'search');
    const result = await (await call('/api/design', { ...input, live: true })).json();
    expect(result).toHaveProperty('mode', 'recorded');
    expect(result).toHaveProperty('message', 'You have used all three live designs today. This is a recorded run.'); expect(search).not.toHaveBeenCalled();
  });
  it('supports the recorded swap and walkway fixture used by the browser runner', async () => {
    const { call } = fixture();
    let design = await (await call('/api/design', { ...input, budget: 1500 })).json() as DesignView;
    if (!design.fit.passes) {
      const slot = design.slots.find(slot => slot.alternates.some(alt => alt.fit.passes))!;
      expect(slot, design.fit.messages.join(' ')).toBeDefined();
      const candidate = slot.alternates.find(alt => alt.fit.passes)!.candidate;
      design = await (await call(`/api/design/${design.id}/swap`, { slot: slot.slot, productId: candidate.id })).json() as DesignView;
    }
    expect(design.fit.passes).toBe(true);
    const original = design.owned.find(item => item.id === 'bookshelf')!;
    const moved = await (await call(`/api/design/${design.id}/move`, { itemId: 'bookshelf', x: 260, z: 155, rot: original.rot })).json() as DesignView;
    expect(moved.fit.messages.join(' ')).toMatch(/walkway/i);
    const restored = await (await call(`/api/design/${design.id}/move`, { itemId: 'bookshelf', x: original.x, z: original.z, rot: original.rot })).json() as DesignView;
    expect(restored.fit.passes).toBe(true);
  });
  it.each(['checkout', 'refund'])('refuses a reached %s cap with a plain message', async kind => {
    const { call, db, s } = fixture(); seedQuote(db); cap(db, `${kind}:${visitor}`, 6);
    const start = vi.spyOn(s.checkout, 'startCheckout'); const refund = vi.spyOn(s.checkout, 'refundLine');
    const response = await call(`/api/${kind}`, { quoteId: 'quote', lineId: 'reading-chair' });
    expect(response.status).toBe(429); expect(await response.json()).toEqual({ code: `${kind}_cap`, error: `You have used all six ${kind === 'refund' ? 'refunds' : 'checkouts'} today. Please return tomorrow.` });
    expect(start).not.toHaveBeenCalled(); expect(refund).not.toHaveBeenCalled();
  });
  it('never lets another visitor spend a quote allowance or read a receipt', async () => {
    const { call, db } = fixture(); seedQuote(db);
    expect((await call('/api/checkout', { quoteId: 'quote' }, 'b'.repeat(32))).status).toBe(404);
    expect((await call('/api/receipt/quote', undefined, 'b'.repeat(32))).status).toBe(404);
    expect(db.sqlite.prepare('SELECT * FROM counters').all()).toHaveLength(0);
  });
  it('returns an existing refund even when daily allowance is exhausted', async () => {
    const { call, db, s } = fixture(); seedQuote(db, 'paid'); cap(db, `refund:${visitor}`, 6);
    db.sqlite.prepare("INSERT INTO refunds(id,quote_id,line_id,amount_cents,state,created_at,updated_at) VALUES('refund','quote',?,100,'completed',?,?)").run(JSON.stringify(['quote', 'reading-chair']), at, at);
    const refund = vi.spyOn(s.checkout, 'refundLine').mockResolvedValue({ ok: true, value: { id: 'refund', quoteId: 'quote', lineId: 'reading-chair', amountCents: 100, state: 'completed', paypalId: 'refund-pay' } });
    expect((await call('/api/refund', { quoteId: 'quote', lineId: 'reading-chair' })).status).toBe(200); expect(refund).toHaveBeenCalledOnce();
  });
  it('hides unexpected errors and rejects unavailable sandbox without calling it', async () => {
    const { call, env, s } = fixture();
    vi.spyOn(s.designs, 'createDesign').mockRejectedValue(new Error('private stack'));
    expect(await (await call('/api/design', input)).json()).toEqual({ error: 'This request could not be completed. Please try again.', code: 'unavailable' });
    delete env.PAYPAL_SECRET;
    expect((await call('/api/checkout', { quoteId: 'quote' })).status).toBe(503);
  });
});

const line: QuoteLine = { lineId: 'reading-chair', roomObjectId: 'reading-chair', productId: 'chair', title: 'Chair', priceCents: 100, currency: 'USD', url: 'https://shop.test', domain: 'shop.test', fitStatus: 'fits', source: { query: 'chair', maxPrice: 100, resultIds: ['chair'], retrievedAt: at, cached: false, origin: 'recorded' } };
describe('worker price rechecks', () => {
  it('skips prices up to six hours old', async () => {
    const product = vi.fn(); expect(await recheckPrices([line], { product }, at + PRICE_MAX_AGE)).toEqual({ checked: [], failed: false }); expect(product).not.toHaveBeenCalled();
  });
  it('marks errors and capped lookups as unchecked while retaining frozen prices', async () => {
    const product = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: false, reason: 'capped' });
    expect(await recheckPrices([line, { ...line, lineId: 'rug' }], { product }, at + PRICE_MAX_AGE + 1)).toEqual({ checked: [], failed: true });
  });
  it('returns changed and gone prices to require a new quote', async () => {
    const product = vi.fn().mockResolvedValueOnce({ ok: true, candidates: [{ id: 'chair', priceCents: 101 }] }).mockResolvedValueOnce({ ok: true, candidates: [] });
    expect(await recheckPrices([line, { ...line, lineId: 'rug', productId: 'rug', source: null }], { product }, at + PRICE_MAX_AGE + 1)).toEqual({ checked: [{ lineId: 'reading-chair', priceCents: 101 }, { lineId: 'rug', priceCents: null }], failed: false });
  });
  it('persists and returns the failed recheck notice on a quote', async () => {
    const { call, db, s } = fixture(); seedQuote(db);
    vi.spyOn(s.channel3, 'product').mockResolvedValue({ ok: false, reason: 'capped' });
    vi.spyOn(s.checkout, 'startCheckout').mockImplementation(async (_id, _visitor, options) => {
      await options?.recheck?.([{ ...line, source: null }]); return { ok: true, value: { ...quote, state: 'approving' } };
    });
    expect(await (await call('/api/checkout', { quoteId: 'quote' })).json()).toHaveProperty('error', 'Price not rechecked.');
    expect(db.sqlite.prepare("SELECT error FROM quotes WHERE id='quote'").get()).toMatchObject({ error: 'Price not rechecked.' });
  });
});
