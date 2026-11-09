import assert from 'node:assert/strict';
import { mkdir, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launchBrowser, ready, designResponse, dragRoomObject, swapFailure } from '../browser-helpers.mjs';
import { approveBuyer } from '../buyer.mjs';

const [baseArg, outArg] = process.argv.slice(2);
if (!baseArg || !outArg) {
  console.error('Usage: node tools/film/tour.mjs <base url> <out dir>');
  process.exit(2);
}
const base = new URL(baseArg);
const out = resolve(outArg);
await mkdir(out, { recursive: true });
const takes = {};
const beats = [];
const failures = [];
let browser;
const only = (process.env.TAKES ?? 'story,brief,phone').split(',');
process.on('unhandledRejection', error => { console.error('late rejection:', String(error?.message ?? error).split(String.fromCharCode(10))[0]); });

async function pointAt(page, locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(400);
  const box = await locator.boundingBox();
  assert.ok(box, 'The target must be visible before moving the cursor.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
}
async function click(page, locator) { await pointAt(page, locator); await locator.click(); }
async function cursor(page) {
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = `#film-cursor{position:fixed;left:0;top:0;width:22px;height:22px;border:2px solid #171717;border-radius:50%;background:#f5f1e8;box-sizing:border-box;pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);opacity:0;transition:opacity .12s}#film-cursor.pulse{animation:film-pulse .32s ease-out}@keyframes film-pulse{0%{box-shadow:0 0 0 0 #17171799}100%{box-shadow:0 0 0 12px #17171700}}`;
    document.documentElement.append(style);
    const cursor = document.createElement('div'); cursor.id = 'film-cursor'; document.body.append(cursor);
    document.addEventListener('mousemove', event => { cursor.style.left = `${event.clientX}px`; cursor.style.top = `${event.clientY}px`; cursor.style.opacity = '1'; });
    document.addEventListener('mousedown', () => { cursor.classList.remove('pulse'); void cursor.offsetWidth; cursor.classList.add('pulse'); });
  });
}
function textOf(locator) { return locator.innerText().then(value => value.trim()); }
async function hold(page, take, name, startedAt, seconds, text) {
  const t = (Date.now() - startedAt) / 1000;
  await page.waitForTimeout(seconds * 1000);
  beats.push({ take, name, t, end: (Date.now() - startedAt) / 1000, text: text.trim() });
}
async function newTake(name, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, recordVideo: { dir: out, size: viewport } });
  let page;
  try {
    page = await context.newPage();
    const startedAt = Date.now();
    page.setDefaultTimeout(20000);
    await cursor(page);
    return { context, page, startedAt };
  } catch (error) { await context.close(); throw error; }
}
async function closeTake(name, take) {
  if (!take) return;
  const video = take.page.video();
  await take.context.close();
  if (video) {
    const source = await video.path();
    const destination = join(out, `${name}.webm`);
    await rename(source, destination);
    takes[name] = destination;
  }
}
async function load(take) {
  take.design = await designResponse(take.page, () => take.page.goto(base.href));
  await ready(take.page);
}
async function freezeAndCheckout(page, method) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const quoteResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/quote' && response.request().method() === 'POST');
    await click(page, page.getByTestId('freeze-quote'));
    await quoteResponse;
    const path = '/api/checkout';
    const checkoutResponse = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    await click(page, page.getByTestId(method === 'card' ? 'pay-card' : 'pay'));
    const response = await checkoutResponse;
    const answer = await response.json();
    if (attempt === 0 && response.status() === 409 && answer.code === 'price_changed') continue;
    assert.ok(response.ok(), 'Checkout must succeed.');
    return answer;
  }
  throw new Error('Checkout price changed twice.');
}
function caption(page) { return page.locator('.room-caption'); }
function swapText(page) {
  return page.locator('#panel .notice, #panel [role="status"]').filter({ hasText: /cm wide|clears the door swing|adds \$/ }).first();
}
function visibleFailure(page) {
  return page.locator('#panel .fit-message, #panel .alarm, #panel [role="alert"]').filter({ hasText: /walkway|door|under 76/i }).first();
}
async function mainTake() {
  let take;
  try {
    take = await newTake('main', { width: 1920, height: 1080 });
    const { page, startedAt } = take;
    await load(take);
    await hold(page, 'main', 'load', startedAt, 6, await textOf(page.locator('#mode-label')) + '\n' + await textOf(caption(page)));

    const canvas = page.locator('#room canvas').first();
    const canvasBox = await canvas.boundingBox(); assert.ok(canvasBox, 'Room canvas must be visible.');
    await page.mouse.move(canvasBox.x + canvasBox.width * .68, canvasBox.y + canvasBox.height * .56, { steps: 25 });
    await hold(page, 'main', 'door', startedAt, 5, await textOf(caption(page)));

    const swap = page.getByRole('button', { name: 'Swap for one that fits' }).first();
    const swapResponse = page.waitForResponse(response => /\/api\/design\/[^/]+\/swap$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
    await click(page, swap);
    const swapDesign = await (await swapResponse).json();
    await page.waitForFunction(() => [...document.querySelectorAll('#panel .notice, #panel [role="status"]')].some(node => /cm wide|clears the door swing|adds \$/i.test(node.textContent ?? '')));
    await hold(page, 'main', 'swap', startedAt, 5, await textOf(swapText(page)));

    await click(page, page.getByTestId('mode-plan'));
    await hold(page, 'main', 'plan-path', startedAt, 4, await textOf(page.locator('#view-hint')));
    const moveResponse = designResponse(page, () => dragRoomObject(page, 'bookshelf', 260, 155));
    const failed = await moveResponse;
    await page.waitForFunction(() => [...document.querySelectorAll('#panel .fit-message, #panel .alarm')].some(node => /walkway|under 76/i.test(node.textContent ?? '')));
    await hold(page, 'main', 'plan-fail', startedAt, 4, (await textOf(visibleFailure(page))) || failed.fit.messages.join(' '));
    const shelf = swapDesign.owned.find(item => item.id === 'bookshelf');
    assert.ok(shelf, 'Bookshelf placement must be available.');
    const restored = await designResponse(page, () => dragRoomObject(page, 'bookshelf', shelf.x, shelf.z));
    if (!restored.fit.passes) failures.push({ take: 'main', error: 'restore did not pass: ' + restored.fit.messages.join(' ') });
    await page.waitForTimeout(800);
    await hold(page, 'main', 'plan-pass', startedAt, 3, 'restored passes: ' + restored.fit.passes);

    await click(page, page.getByTestId('mode-overview'));
    const briefInput = page.getByLabel('Tell RoomWeft about the room');
    await pointAt(page, briefInput); await briefInput.fill('I read in the evening, under $700', { timeout: 20000 });
    const live = page.getByRole('button', { name: 'Search live', exact: true });
    if (await live.isEnabled()) {
      const response = page.waitForResponse(result => /\/api\/design$/.test(new URL(result.url()).pathname) && result.request().method() === 'POST', { timeout: 90000 });
      await click(page, live); const answer = await response; console.error("live design status", answer.status()); await ready(page, 60000);
    }
    for (let retry = 0; retry < 2; retry++) {
      const said = await textOf(page.getByTestId('brief-understood')).catch(() => '');
      if (!/by rules/i.test(said) || !(await live.isEnabled())) break;
      console.error('brief read by rules, pressing Search live again');
      const again = page.waitForResponse(result => /\/api\/design$/.test(new URL(result.url()).pathname) && result.request().method() === 'POST', { timeout: 90000 });
      await click(page, live); await again; await ready(page, 60000);
    }
    const brief = page.getByTestId('brief-understood');
    await brief.waitFor({ state: 'visible' }).catch(() => {});
    if (await brief.count()) await brief.scrollIntoViewIfNeeded();
    const briefText = await brief.count() ? await textOf(brief) : await textOf(page.locator('#panel [role="alert"], #panel .notice').filter({ hasText: /cap|limit|today|unavailable/i }).first());
    await hold(page, 'main', 'brief', startedAt, 5, briefText || await textOf(page.locator('#panel')));

    const picks = page.locator('#picks'); await picks.scrollIntoViewIfNeeded();
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 150); await page.waitForTimeout(180); }
    if (true) {
      await designResponse(page, () => click(page, page.getByTestId('style-warm-reading')));
      await ready(page);
      await page.locator('[data-testid="slot-rug"]').scrollIntoViewIfNeeded();
    }
    const amber = page.locator('[data-testid^="slot-"] >> text=/Fit unverified/ >> visible=true').first();
    await amber.waitFor({ state: 'visible' });
    await hold(page, 'main', 'picks', startedAt, 4, await textOf(amber));

    const sale = await freezeAndCheckout(page, 'card');
    const receipt = page.getByTestId('receipt');
    await receipt.getByText('Paid in the PayPal sandbox', { exact: true }).waitFor();
    await hold(page, 'main', 'pay', startedAt, 5, await textOf(receipt));

    const lines = receipt.locator('.receipt-line');
    const count = await lines.count(); assert.ok(count >= 2, 'At least two receipt lines are needed for the thread shot.');
    for (let i = 0; i < 2; i++) {
      const line = lines.nth(i); await pointAt(page, line);
      await hold(page, 'main', `thread-${i + 1}`, startedAt, 3, await textOf(line));
    }

    const deadline = Date.now() + 75000;
    while (Date.now() < deadline && !(await receipt.getByText(/Payment captured/).count())) {
      await click(page, page.getByRole('button', { name: 'Refresh receipt', exact: true })).catch(async () => { await page.reload(); await ready(page); });
      await receipt.getByText(/Payment captured/).waitFor({ timeout: 3000 }).catch(() => {});
    }
    await receipt.getByText(/Payment captured/).waitFor({ timeout: 1000 });
    await receipt.scrollIntoViewIfNeeded();
    await hold(page, 'main', 'events', startedAt, 4, (await receipt.locator('.receipt-event').allInnerTexts()).join(String.fromCharCode(10)));

    const receiptData = await page.evaluate(async id => {
      const response = await fetch(`/api/receipt/${encodeURIComponent(id)}`); return response.json();
    }, sale.quote?.id ?? sale.id);
    const lamp = receiptData.lines.find(line => /floor lamp/i.test(line.title)) ?? receiptData.lines[0];
    await click(page, page.getByTestId(`refund-${lamp.lineId}`));
    const refundDeadline = Date.now() + 60000;
    let updated;
    do {
      const response = await page.request.get(new URL(`/api/receipt/${encodeURIComponent(receiptData.quote.id)}`, base).href);
      updated = await response.json();
      if (updated.lines.find(line => line.lineId === lamp.lineId)?.refund?.state === 'completed') break;
      await page.waitForTimeout(1200);
    } while (Date.now() < refundDeadline);
    assert.equal(updated.lines.find(line => line.lineId === lamp.lineId)?.refund?.state, 'completed');
    await page.reload(); await ready(page); await receipt.waitFor();
    const returnedLine = receipt.locator('.receipt-line').filter({ hasText: 'Returned' }).first();
    await returnedLine.waitFor({ state: 'visible' });
    await hold(page, 'main', 'refund', startedAt, 5, await textOf(returnedLine));

    await click(page, page.getByTestId('mode-walk'));
    const walkCanvas = page.locator('#room canvas').first(); await walkCanvas.focus();
    const walkText = await textOf(page.locator('#view-hint'));
    for (const key of ['w', 'w', 'ArrowRight', 'w', 'ArrowLeft', 'w']) {
      await page.keyboard.down(key); await page.waitForTimeout(2800); await page.keyboard.up(key);
    }
    await hold(page, 'main', 'walk', startedAt, 2, walkText);

    await click(page, page.getByTestId('mode-overview'));
    await page.evaluate(() => window.scrollTo(0, 0));
    const status = await textOf(page.locator('#status'));
    const judges = page.getByTestId('judges'); await judges.scrollIntoViewIfNeeded();
    await click(page, judges.locator('summary'));
    const judgeText = await textOf(judges.locator('ol'));
    await hold(page, 'main', 'status', startedAt, 5, `${status}\n${judgeText}`);
  } catch (error) { failures.push({ take: 'main', error: String(error?.message ?? error) }); }
  finally { await closeTake('main', take).catch(error => failures.push({ take: 'main', error: String(error?.message ?? error) })); }
}
async function paypalTake() {
  let take;
  try {
    take = await newTake('paypal', { width: 1920, height: 1080 });
    const { page, startedAt } = take;
    await load(take);
    await swapFailure(page, take.design).catch(async () => { await click(page, page.getByRole('button', { name: 'Swap for one that fits' }).first()); await page.waitForTimeout(3000); });
    await ready(page);
    const quoteResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/quote' && response.request().method() === 'POST');
    await click(page, page.getByTestId('freeze-quote')); await quoteResponse;
    await hold(page, 'paypal', 'paypal-button', startedAt, 4, await textOf(page.getByTestId('pay')));
    const checkoutResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/checkout' && response.request().method() === 'POST');
    await click(page, page.getByTestId('pay'));
    const checkoutResult = await checkoutResponse;
    const checkout = await checkoutResult.json();
    assert.ok(checkoutResult.ok(), 'PayPal checkout must succeed.');
    await approveBuyer(page, checkout.approveUrl, { email: process.env.BUYER_EMAIL, password: process.env.BUYER_PASSWORD });
    const paypalText = await page.locator('body').innerText();
    await hold(page, 'paypal', 'paypal-page', startedAt, 4, paypalText);
    await ready(page); const receipt = page.getByTestId('receipt'); await receipt.getByText('Paid in the PayPal sandbox', { exact: true }).waitFor();
    await hold(page, 'paypal', 'paypal-paid', startedAt, 4, await textOf(receipt));
  } catch (error) { failures.push({ take: 'paypal', error: String(error?.message ?? error) }); }
  finally { await closeTake('paypal', take).catch(error => failures.push({ take: 'paypal', error: String(error?.message ?? error) })); }
}
async function walkTake() {
  let take;
  try {
    take = await newTake('walk', { width: 1920, height: 1080 });
    const { page, startedAt } = take;
    await load(take);
    await designResponse(page, () => click(page, page.getByTestId('style-warm-reading'))); await ready(page);
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(800);
    await click(page, page.getByTestId('mode-walk')); await page.waitForTimeout(800);
    await page.evaluate(() => { const c = document.getElementById('film-cursor'); if (c) c.style.display = 'none'; });
    const box = await page.locator('#room canvas').first().boundingBox();
    const cy = box.y + box.height / 2;
    let x = box.x + box.width - 20;
    await page.mouse.move(x, cy); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(1500);
    const t0 = (Date.now() - startedAt) / 1000;
    async function pan(dx, seconds) { const steps = Math.round(seconds * 30); const from = x; for (let i = 1; i <= steps; i++) { x = from + dx * i / steps; await page.mouse.move(x, cy); await page.waitForTimeout(1000 / 30); } }
    async function key(k, seconds) { await page.keyboard.down(k); await page.waitForTimeout(seconds * 1000); await page.keyboard.up(k); }
    await page.waitForTimeout(1500);
    await pan(-Number(process.env.WALK_TURN ?? 1100), 6); await page.waitForTimeout(1200);
    await key('w', Number(process.env.WALK_STEP ?? 0.9)); await page.waitForTimeout(1200);
    await pan(160, 2); await page.waitForTimeout(1000);
    await pan(-160, 2); await page.waitForTimeout(1500);
    beats.push({ take: 'walk', name: 'walk', t: t0, end: (Date.now() - startedAt) / 1000, text: await textOf(page.locator('#view-hint')) });
    await page.waitForTimeout(1500);
  } catch (error) { failures.push({ take: 'walk', error: String(error?.message ?? error) }); }
  finally { await closeTake('walk', take).catch(error => failures.push({ take: 'walk', error: String(error?.message ?? error) })); }
}
async function phoneTake() {
  let take;
  try {
    take = await newTake('phone', { width: 390, height: 844 });
    const { page, startedAt } = take;
    await load(take); await hold(page, 'phone', 'phone-load', startedAt, 3, await textOf(page.locator('#mode-label')));
    const picks = page.getByRole('link', { name: 'Picks and basket' }); await click(page, picks);
    await hold(page, 'phone', 'phone-picks', startedAt, 3, await textOf(page.locator('#picks')));
    const back = page.getByRole('link', { name: 'Back to room' }); await click(page, back);
    await hold(page, 'phone', 'phone', startedAt, 3, await textOf(page.locator('#room')));
  } catch (error) { failures.push({ take: 'phone', error: String(error?.message ?? error) }); }
  finally { await closeTake('phone', take).catch(error => failures.push({ take: 'phone', error: String(error?.message ?? error) })); }
}

// Where a proof sits on screen, in video pixels, so the cut can show it as a readable close up.
async function boxOf(locator) {
  const box = await locator.boundingBox().catch(() => null);
  return box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null;
}
async function holdOn(page, take, name, startedAt, seconds, locator, extra = '') {
  await locator.scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(500);
  const t = (Date.now() - startedAt) / 1000; const box = await boxOf(locator);
  const text = ((await textOf(locator).catch(() => '')) + (extra ? `\n${extra}` : '')).trim();
  await page.waitForTimeout(seconds * 1000);
  beats.push({ take, name, t, end: (Date.now() - startedAt) / 1000, text, box });
}
async function walkLook(page, startedAt, take) {
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(600);
  await click(page, page.getByTestId('mode-walk')); await page.waitForTimeout(800);
  const box = await page.locator('#room canvas').first().boundingBox();
  const cy = box.y + box.height / 2; let x = box.x + box.width - 20;
  await page.mouse.move(x, cy); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(1200);
  const t0 = (Date.now() - startedAt) / 1000;
  async function pan(dx, seconds) { const steps = Math.round(seconds * 30); const from = x; for (let i = 1; i <= steps; i++) { x = from + dx * i / steps; await page.mouse.move(x, cy); await page.waitForTimeout(1000 / 30); } }
  async function key(k, seconds) { await page.keyboard.down(k); await page.waitForTimeout(seconds * 1000); await page.keyboard.up(k); }
  await pan(-Number(process.env.WALK_TURN ?? 1100), 6); await page.waitForTimeout(1000);
  await key('w', Number(process.env.WALK_STEP ?? 0.9)); await page.waitForTimeout(1000);
  await pan(160, 2); await page.waitForTimeout(800); await pan(-160, 2); await page.waitForTimeout(1200);
  beats.push({ take, name: 'walk', t: t0, end: (Date.now() - startedAt) / 1000, text: await textOf(page.locator('#view-hint')).catch(() => ''), box: null });
  await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(500);
  await click(page, page.getByTestId('mode-overview')); await page.waitForTimeout(800);
}
// One renter, one basket, one purchase: the order the review asked for.
async function storyTake() {
  let take;
  try {
    take = await newTake('story', { width: 1920, height: 1080 });
    const { page, startedAt } = take;
    await load(take);
    await hold(page, 'story', 'load', startedAt, 6, await textOf(caption(page)));

    const roomBox = page.getByTestId('room-size');
    if (await roomBox.count()) {
      const fold = page.getByTestId('furniture-sizes');
      if (await fold.count()) await click(page, fold.locator('summary')).catch(() => {});
      await holdOn(page, 'story', 'room', startedAt, 5, roomBox);
    } else beats.push({ take: 'story', name: 'room', t: 0, end: 0, text: 'sample room only', box: null });

    const chairCard = page.getByTestId('slot-reading-chair');
    await page.evaluate(() => window.scrollTo(0, 0));
    const canvasBox = await page.locator('#room canvas').first().boundingBox();
    await page.mouse.move(canvasBox.x + canvasBox.width * .68, canvasBox.y + canvasBox.height * .56, { steps: 25 });
    await hold(page, 'story', 'door-room', startedAt, 3, await textOf(caption(page)));
    await holdOn(page, 'story', 'door-card', startedAt, 5, chairCard);

    const swap = chairCard.getByRole('button', { name: 'Swap for one that fits' });
    const swapResponse = page.waitForResponse(response => /\/api\/design\/[^/]+\/swap$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
    await click(page, swap);
    const swapDesign = await (await swapResponse).json();
    await page.waitForFunction(() => [...document.querySelectorAll('#panel .notice, #panel [role="status"]')].some(node => /cm wide|clears the door swing|adds \$/i.test(node.textContent ?? '')));
    await holdOn(page, 'story', 'swap', startedAt, 5, swapText(page));
    await holdOn(page, 'story', 'swap-card', startedAt, 4, page.getByTestId('slot-reading-chair'));

    await page.evaluate(() => window.scrollTo(0, 0));
    await click(page, page.getByTestId('mode-plan'));
    await hold(page, 'story', 'plan-path', startedAt, 4, await textOf(page.locator('#view-hint')));
    const failed = await designResponse(page, () => dragRoomObject(page, 'bookshelf', 260, 155));
    await page.waitForFunction(() => [...document.querySelectorAll('#panel .fit-message, #panel .alarm')].some(node => /walkway|under 76/i.test(node.textContent ?? '')));
    await hold(page, 'story', 'plan-fail', startedAt, 4, (await textOf(visibleFailure(page)).catch(() => '')) || failed.fit.messages.join(' '));
    const shelf = swapDesign.owned.find(item => item.id === 'bookshelf');
    const restored = await designResponse(page, () => dragRoomObject(page, 'bookshelf', shelf.x, shelf.z));
    if (!restored.fit.passes) failures.push({ take: 'story', error: 'restore did not pass: ' + restored.fit.messages.join(' ') });
    await hold(page, 'story', 'plan-pass', startedAt, 3, 'restored passes: ' + restored.fit.passes);
    await click(page, page.getByTestId('mode-overview'));

    const rugCard = page.getByTestId('slot-rug');
    const rugSize = await rugCard.locator('.pick-size').first().innerText().catch(() => '');
    if (/\d\s*[x×]\s*\d/.test(rugSize)) {
      const options = rugCard.locator('details').first(); await click(page, options.locator('summary'));
      const unsized = rugCard.locator('.alternate').filter({ hasText: 'Fit unverified' }).first();
      if (await unsized.count()) {
        await holdOn(page, 'story', 'unverified-option', startedAt, 3, unsized);
        await designResponse(page, () => click(page, unsized.getByRole('button', { name: 'Choose this item' })));
        await ready(page);
      } else failures.push({ take: 'story', error: 'no unsized rug option in this run' });
    }
    await holdOn(page, 'story', 'unverified-card', startedAt, 4, page.getByTestId('slot-rug'));
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(400);
    await hold(page, 'story', 'unverified-room', startedAt, 4, await textOf(caption(page)));

    await walkLook(page, startedAt, 'story');

    await holdOn(page, 'story', 'summary', startedAt, 3, page.getByTestId('summary'));
    await holdOn(page, 'story', 'basket', startedAt, 4, page.locator('#basket, [data-testid="basket"]').first());
    let repriced = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const quoteResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/quote' && response.request().method() === 'POST');
      await click(page, page.getByTestId('freeze-quote')); await quoteResponse;
      await holdOn(page, 'story', attempt ? 'quote-again' : 'quote', startedAt, 3, page.getByTestId('pay-card'));
      const checkoutResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/checkout' && response.request().method() === 'POST', { timeout: 60000 });
      await click(page, page.getByTestId('pay-card'));
      const response = await checkoutResponse; const answer = await response.json();
      if (attempt === 0 && response.status() === 409 && answer.code === 'price_changed') {
        repriced = true; await page.waitForTimeout(800);
        await holdOn(page, 'story', 'reprice', startedAt, 5, page.locator('#panel .notice, #panel [role="alert"], #panel .alarm').filter({ hasText: /price/i }).first());
        continue;
      }
      assert.ok(response.ok(), 'Checkout must succeed.');
      const state = answer.quote?.state ?? answer.state; console.error('card checkout', response.status(), state, answer.quote?.error ?? answer.error ?? '');
      if (attempt === 0 && state === 'declined') { failures.push({ take: 'story', error: 'card declined once: ' + JSON.stringify(answer).slice(0, 300) }); continue; }
      take.sale = answer; break;
    }
    const receipt = page.getByTestId('receipt');
    await receipt.getByText('Paid in the PayPal sandbox', { exact: true }).waitFor();
    await holdOn(page, 'story', 'pay', startedAt, 6, receipt, repriced ? 'repriced first' : '');
    const line = receipt.locator('.receipt-line').first(); await pointAt(page, line);
    await hold(page, 'story', 'thread', startedAt, 4, await textOf(line));

    const deadline = Date.now() + 75000;
    while (Date.now() < deadline && !(await receipt.getByText(/Payment captured/).count())) {
      await click(page, page.getByRole('button', { name: 'Refresh receipt', exact: true })).catch(async () => { await page.reload(); await ready(page); });
      await receipt.getByText(/Payment captured/).waitFor({ timeout: 3000 }).catch(() => {});
    }
    await holdOn(page, 'story', 'events', startedAt, 4, receipt.locator('.receipt-event').first());

    const receiptId = take.sale.quote?.id ?? take.sale.id;
    const receiptData = await page.evaluate(async id => (await fetch(`/api/receipt/${encodeURIComponent(id)}`)).json(), receiptId);
    const lamp = receiptData.lines.find(item => /lamp/i.test(item.title)) ?? receiptData.lines[0];
    await click(page, page.getByTestId(`refund-${lamp.lineId}`));
    const refundDeadline = Date.now() + 60000; let updated;
    do {
      updated = await (await page.request.get(new URL(`/api/receipt/${encodeURIComponent(receiptData.quote.id)}`, base).href)).json();
      if (updated.lines.find(item => item.lineId === lamp.lineId)?.refund?.state === 'completed') break;
      await page.waitForTimeout(1200);
    } while (Date.now() < refundDeadline);
    await page.reload(); await ready(page); await receipt.waitFor();
    const returnedLine = receipt.locator('.receipt-line').filter({ hasText: 'Returned' }).first();
    await returnedLine.waitFor({ state: 'visible' });
    await holdOn(page, 'story', 'refund', startedAt, 5, returnedLine);
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(500);
    await hold(page, 'story', 'returned-room', startedAt, 4, await textOf(caption(page)));

    const replace = page.getByTestId('replace-item').first();
    if (await replace.count()) {
      await click(page, replace);
      const quote = page.getByTestId('replacement-quote'); await quote.waitFor({ timeout: 30000 });
      await holdOn(page, 'story', 'replacement-quote', startedAt, 5, quote);
      let checkout;
      for (let attempt = 0; attempt < 2; attempt++) {
        const checkoutResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/checkout' && response.request().method() === 'POST', { timeout: 60000 });
        await click(page, page.getByTestId('pay'));
        const answer = await checkoutResponse; checkout = await answer.json();
        if (answer.status() !== 409 || checkout.code !== 'price_changed') break;
        // The shop changed the price since the saved run: a new replacement quote takes it.
        await holdOn(page, 'story', 'replacement-reprice', startedAt, 4, page.locator('#basket'));
        const fresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/replace', { timeout: 30000 });
        await click(page, page.getByTestId('replace-again')); await fresh; await quote.waitFor({ timeout: 30000 });
      }
      await approveBuyer(page, checkout.approveUrl, { email: process.env.BUYER_EMAIL, password: process.env.BUYER_PASSWORD });
      await hold(page, 'story', 'paypal-page', startedAt, 3, await page.locator('body').innerText());
      await ready(page);
      const paid = page.getByTestId('replacement-receipt'); await paid.waitFor({ timeout: 60000 });
      await holdOn(page, 'story', 'replacement-paid', startedAt, 5, paid);
    }

    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(400);
    await holdOn(page, 'story', 'status', startedAt, 4, page.locator('#status'));
  } catch (error) { failures.push({ take: 'story', error: String(error?.message ?? error) }); }
  finally { await closeTake('story', take).catch(error => failures.push({ take: 'story', error: String(error?.message ?? error) })); }
}
// A second visitor's live design from one sentence (labelled as a separate design in the cut).
async function briefTake() {
  let take;
  try {
    take = await newTake('brief', { width: 1920, height: 1080 });
    const { page, startedAt } = take;
    await load(take);
    const input = page.getByLabel('Tell RoomWeft about the room');
    await pointAt(page, input); await input.fill('');
    await input.pressSequentially('I read in the evening, under $700', { delay: 70 });
    const t = (Date.now() - startedAt) / 1000;
    beats.push({ take: 'brief', name: 'typed', t: t - 3, end: t, text: 'I read in the evening, under $700', box: await boxOf(input) });
    const live = page.getByRole('button', { name: 'Search live', exact: true });
    const response = page.waitForResponse(result => /\/api\/design$/.test(new URL(result.url()).pathname) && result.request().method() === 'POST', { timeout: 90000 });
    const asked = (Date.now() - startedAt) / 1000;
    await click(page, live); await response; await ready(page, 60000);
    beats.push({ take: 'brief', name: 'wait', t: asked, end: (Date.now() - startedAt) / 1000, text: 'live design wait', box: null });
    const box = page.getByTestId('brief-understood');
    const details = box.locator('details').first();
    if (await details.count()) await click(page, details.locator('summary'));
    await holdOn(page, 'brief', 'understood', startedAt, 6, box);
  } catch (error) { failures.push({ take: 'brief', error: String(error?.message ?? error) }); }
  finally { await closeTake('brief', take).catch(error => failures.push({ take: 'brief', error: String(error?.message ?? error) })); }
}

try {
  browser = await launchBrowser();
  if (only.includes('story')) await storyTake();
  if (only.includes('brief')) await briefTake();
  if (only.includes('main')) await mainTake();
  if (only.includes('paypal')) await paypalTake();
  if (only.includes('phone')) await phoneTake();
  if (only.includes('walk')) await walkTake();
} catch (error) { failures.push({ take: 'setup', error: String(error?.message ?? error) }); }
finally {
  await browser?.close().catch(() => {});
  await import('node:fs/promises').then(({ writeFile }) => writeFile(join(out, 'beats.json'), JSON.stringify({ takes, beats, failures }, null, 2) + '\n', 'utf8'));
}
if (failures.length) {
  for (const failure of failures) console.error(`${failure.take}: ${failure.error.split(String.fromCharCode(10)).slice(0, 3).join(' | ')}`);
  console.error(`Tour failed in ${failures.length} take(s). Logged ${beats.length} beats to ${join(out, 'beats.json')}.`);
  process.exitCode = 1;
}
