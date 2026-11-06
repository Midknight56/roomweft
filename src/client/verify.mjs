import { chromium } from 'playwright';
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
await mkdir('out/page-check', { recursive: true });
const bundle = await build({ stdin: { contents: "export * from './src/shared/room'; export * from './src/shared/fit'; export * from './src/client/helpers';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { OWNED_ITEMS, ROOM, DOOR, WINDOW, layoutOf, checkFit } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const pick = (id, price, w, d, h) => ({ id, title: ({ 'reading-chair': 'Linen reading chair', 'floor-lamp': 'Warm paper floor lamp', 'side-table': 'Small oak side table', rug: 'Woven wool rug' })[id], priceCents: price, currency: 'USD', url: 'https://example.com/item', domain: 'example.com', colors: ['#B98764'], materials: ['Wood', 'Linen'], dims: { w, d, h } });
const source = { query: 'small room', maxPrice: 30000, resultIds: ['chair'], retrievedAt: 1793952000000, cached: true, origin: 'recorded' };
function makeDesign(pass = false) {
  const values = [['reading-chair', 25000, pass ? 60 : 90, pass ? 60 : 90, 80, pass ? 335 : 300, pass ? 65 : 55, 270], ['floor-lamp', 6000, 30, 30, 150, 55, 255, 0], ['side-table', 7000, 40, 40, 50, 165, 260, 0], ['rug', 9000, 170, 120, 10, 190, 150, 0]];
  const design = { id: 'review-room', version: pass ? 2 : 1, mode: 'recorded', style: 'warm-reading', capturedAt: '2026-11-06', budgetCents: 60000, owned: OWNED_ITEMS.map(({ id, x, z, rot, locked }) => ({ id, x, z, rot, locked })), slots: values.map(([id, price, w, d, h, x, z, rot]) => ({ slot: id, pick: pick(id, price, w, d, h), by: 'recorded', reason: 'Soft fabric and warm wood for a small room.', placement: { x, z, rot }, alternates: [], source })), totals: { totalCents: 47000, budgetCents: 60000, overCents: 0, unverifiedCount: 0 }, labels: { search: 'recorded', ai: 'recorded' } };
  design.fit = checkFit(layoutOf(design), ROOM, DOOR, WINDOW, { budget: design.budgetCents, prices: Object.fromEntries(design.slots.map(s => [s.slot, s.pick.priceCents])) });
  if (!pass) design.slots[0].alternates = [{ candidate: { ...pick('reading-chair', 21000, 60, 60, 80), id: 'small-chair' }, fit: { passes: true, messages: [] }, verified: true, priceDeltaCents: -4000 }];
  else { design.slots[0].pick.priceCents = 21000; design.totals.totalCents = 43000; design.swapNote = 'This chair clears the door and saves $40.00.'; }
  return design;
}
let design = makeDesign(); let quote; let receipt; let moveRefused = false; let scenesFail = false; let unknown = false; let moves = 0;
  let pageError; const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }); page.on('pageerror', error => { pageError = error; });
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname !== 'room.test') return route.abort();
    if (path === '/api/scenes') return scenesFail ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The room service is unavailable.', code: 'offline' }) }) : json({});
    if (path === '/api/status') return json({ search: { live: true, remainingToday: 10 }, ai: { live: false, remainingNeuronsToday: 0 }, sandbox: { live: true }, visitor: { liveDesignsLeft: 3, checkoutsLeft: 6, refundsLeft: 6 } });
    if (path === '/api/design') return json(design);
    if (path.endsWith('/swap')) { design = makeDesign(true); return json(design); }
    if (path.endsWith('/move')) { moves++; if (moveRefused) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'locked', error: 'This move was refused by the server.' }) }); const body = request.postDataJSON(); design.slots.find(s => s.slot === body.itemId).placement = { x: body.x, z: body.z, rot: body.rot }; design.version++; return json(design); }
    if (path === '/api/quote') { quote = { id: 'review-quote', designId: design.id, designVersion: design.version, lines: design.slots.map(s => ({ lineId: s.slot, roomObjectId: s.slot, productId: s.pick.id, title: s.pick.title, priceCents: s.pick.priceCents, currency: 'USD', url: s.pick.url, domain: s.pick.domain, fitStatus: 'fits', source })), totalCents: design.totals.totalCents, state: 'open' }; return json(quote); }
    if (path === '/api/checkout') { quote.state = unknown ? 'capture_unknown' : 'approving'; return json(quote); }
    if (path.startsWith('/api/receipt/')) return json(receipt ?? { quote, orderId: null, captureId: null, capturedCents: 0, refundedCents: 0, lines: quote.lines.map(line => ({ ...line, refund: null })), plan: quote.lines.map(line => ({ roomObjectId: line.roomObjectId, status: 'paid' })) });
    if (path === '/api/refund') { receipt.lines[0].refund = { state: 'completed', amountCents: 21000, paypalId: 'test-refund' }; receipt.plan[0].status = 'returned'; return json({ id: 'test-refund-record', quoteId: quote.id, lineId: receipt.lines[0].lineId, amountCents: 21000, state: 'completed', paypalId: 'test-refund' }); }
    const files = { '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/styles.css': ['public/styles.css', 'text/css'], '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'] };
    if (files[path]) return route.fulfill({ contentType: files[path][1], body: await readFile(files[path][0]) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://room.test/'); await page.getByRole('button', { name: 'Swap for one that fits', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Freeze quote', exact: true }).isDisabled(), true);
  await page.screenshot({ path: 'out/page-check/review-desktop.png' });
  await page.getByRole('button', { name: 'Swap for one that fits', exact: true }).click(); await page.getByText('This chair clears the door and saves $40.00.').waitFor();
  assert.equal(design.fit.passes, true, JSON.stringify(design.fit.messages));
  assert.equal(await page.getByRole('button', { name: 'Freeze quote', exact: true }).isEnabled(), true);
  await page.locator('.pick').first().hover(); await page.waitForTimeout(100); assert.ok((await page.locator('.threads path').getAttribute('d')).length > 0);
  await page.getByRole('button', { name: 'Plan view', exact: true }).click(); await page.waitForTimeout(750);
  const coordinate = async (x, z) => { const rect = await page.getByTestId('plan-floor').boundingBox(); return { x: rect.x + x / ROOM.width * rect.width, y: rect.y + (1 - z / ROOM.depth) * rect.height }; };
  let start = await coordinate(335, 65); let end = await coordinate(325, 65);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(200);
  assert.equal(moves, 1); assert.equal(design.slots[0].placement.x, 325);
  moveRefused = true; start = await coordinate(325, 65); end = await coordinate(315, 65);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up(); await page.getByText('This move was refused by the server.').waitFor(); assert.equal(moves, 2); assert.equal(design.slots[0].placement.x, 325);
  moveRefused = false; await page.getByRole('combobox', { name: 'Select movable furniture' }).selectOption('reading-chair'); await page.getByRole('button', { name: 'Rotate ↻', exact: true }).click(); await page.waitForTimeout(100); assert.equal(design.slots[0].placement.rot, 0);
  await page.screenshot({ path: 'out/page-check/review-plan.png' });
  await page.getByRole('button', { name: 'Walk view', exact: true }).click(); await page.waitForTimeout(750); await page.screenshot({ path: 'out/page-check/review-walk.png' }); await page.locator('#room canvas').focus(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Freeze quote', exact: true }).click(); await page.getByText('Frozen total $430.00').waitFor();
  unknown = true; await page.getByRole('button', { name: 'Pay with PayPal (sandbox)', exact: true }).click(); await page.getByText('Checking payment', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Pay with PayPal (sandbox)', exact: true }).count(), 0);
  await page.reload(); await page.getByText('Checking payment', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Pay with PayPal (sandbox)', exact: true }).count(), 0);
  receipt = { quote: { ...quote, state: 'paid' }, orderId: 'test-order', captureId: 'test-capture', capturedCents: 43000, refundedCents: 0, lines: quote.lines.map(line => ({ ...line, refund: null })), plan: quote.lines.map(line => ({ roomObjectId: line.roomObjectId, status: 'paid' })) };
  await page.evaluate(saved => sessionStorage.setItem('roomweft-payment-room', JSON.stringify(saved)), { quoteId: quote.id, design });
  await page.goto('http://room.test/?receipt=review-quote'); await page.getByText('Capture test-capture').waitFor(); await page.getByText('Paid in the PayPal sandbox', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Refund this item', exact: true }).first().click(); await page.getByText('Refund completed', { exact: true }).waitFor(); await page.getByText('Returned', { exact: true }).waitFor();
  await page.reload(); await page.getByText('Paid in the PayPal sandbox', { exact: true }).waitFor(); await page.getByText('Returned', { exact: true }).waitFor();
  assert.equal(await page.getByText('The room plan and the receipt now differ. Freeze a new quote to buy a replacement.').count(), 1);
  for (const [state, message] of Object.entries({ cancelled: 'Payment was cancelled.', declined: 'Payment was declined.', stale: 'The design changed. Freeze a new quote.', changed: 'The design changed. Freeze a new quote.' })) {
    await page.goto(`http://room.test/?receipt=review-quote&checkout=${state}`);
    await page.locator('#panel > div').first().locator('.notice').filter({ hasText: message }).waitFor();
    assert.equal(await page.locator('#panel > div').first().locator('.notice').textContent(), message);
    assert.equal(await page.getByText(message, { exact: true }).count(), 1);
    assert.equal(await page.locator('section.step').filter({ has: page.getByTestId('freeze-quote') }).locator('.notice').filter({ hasText: message }).count(), 0);
    assert.equal(await page.locator('#panel > div').first().getByText(design.swapNote, { exact: true }).count(), 0);
    assert.equal(await page.locator('#panel > div').first().evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }), true, 'checkout notice stays in the first view');
    if (state === 'cancelled') await page.screenshot({ path: 'out/page-check/review-cancelled.png' });
  }
  for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport); await page.getByRole('button', { name: 'Plan view', exact: true }).click(); await page.waitForTimeout(100);
    assert.equal(await page.locator('.plan-tools').evaluate(tools => { const floor = document.querySelector('[data-testid="plan-floor"]'); const a = tools.getBoundingClientRect(); const b = floor.getBoundingClientRect(); return a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom; }), true, `${viewport.width}px plan tools overlap floor`);
    const framing = await page.locator('#room').evaluate(host => {
      const floor = host.querySelector('[data-testid="plan-floor"]').getBoundingClientRect();
      const modes = host.querySelector('.view-modes').getBoundingClientRect();
      const tools = host.querySelector('.plan-tools').getBoundingClientRect();
      const room = host.getBoundingClientRect();
      const free = { left: room.left + host.clientLeft + 8, right: room.left + host.clientLeft + host.clientWidth - 8, top: modes.bottom + 8, bottom: tools.top - 8 };
      return { inside: floor.left >= free.left && floor.right <= free.right && floor.top >= free.top && floor.bottom <= free.bottom, fill: Math.max(floor.width / (free.right - free.left), floor.height / (free.bottom - free.top)) };
    });
    assert.equal(framing.inside, true, `${viewport.width}px floor must stay inside the free rectangle`);
    assert.ok(framing.fill >= .7, `${viewport.width}px floor must fill at least 70 percent of the free width or height`);
    await page.screenshot({ path: `out/page-check/review-plan-${viewport.width}.png` });
    if (viewport.width === 360) await page.screenshot({ path: 'out/page-check/review-phone.png', fullPage: true });
  }
  await page.setViewportSize({ width: 360, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'phone overflow');
  receipt.recorded = true; await page.reload(); await page.getByText('Recorded receipt, makes no payment', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Refund this item', exact: true }).first().isDisabled(), true);
  receipt = undefined; design.mode = 'rules'; design.labels.ai = 'rules'; await page.goto('http://room.test/'); await page.getByText('Picked by rules, no AI today', { exact: true }).waitFor();
  design.slots[0].pick.dims = null; design.slots[3].pick.dims = null; design.fit.unverified = ['reading-chair', 'rug']; design.totals.unverifiedCount = 2; await page.reload(); await page.locator('.pick .badge').filter({ hasText: 'Fit unverified' }).first().waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const mode of ['Plan', 'Overview', 'Walk']) {
    await page.getByRole('button', { name: `${mode} view`, exact: true }).click();
    await page.waitForFunction(() => window.__roomweftReady === true);
    await page.waitForTimeout(750);
    assert.equal(await page.locator('#room canvas').evaluate(canvas => canvas.style.transform), mode === 'Plan' ? 'scaleX(-1)' : '');
    await page.screenshot({ path: `out/page-check/review-unverified-${mode.toLowerCase()}.png` });
  }
  scenesFail = true; await page.goto('http://room.test/'); await page.getByRole('button', { name: 'Retry', exact: true }).waitFor(); scenesFail = false; await page.getByRole('button', { name: 'Retry', exact: true }).click(); await page.getByRole('heading', { name: 'Your room' }).waitFor();
  assert.equal(pageError, undefined, pageError?.message ?? 'page error'); console.log(JSON.stringify({ browser: 'passed', checks: ['initial failure blocks quote', 'swap clears fit and updates total', 'woven thread draws', 'accepted plan drag', 'refused plan drag', 'keyboard selection and rotation', 'plan labels across cameras', 'plan fits free rectangle at 360, 390, 768 and 1440px', 'clear walk start', 'checkout return top and basket notices', 'unknown capture blocks payment across reload', 'return restores room', 'refund and receipt', 'recorded receipt is read only', 'rules and unverified labels', '360px has no horizontal scroll', 'scene failure and retry'], pageErrors: [] }));
} finally { await browser.close(); }
