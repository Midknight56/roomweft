import { chromium } from 'playwright';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const bundle = await build({ stdin: { contents: "export * from './src/shared/room'; export * from './src/shared/fit'; export * from './src/client/helpers';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { OWNED_ITEMS, ROOM, DOOR, WINDOW, layoutOf, checkFit } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const pick = (id, price, w, d, h) => ({ id, title: ({ 'reading-chair': 'Linen reading chair', 'floor-lamp': 'Warm paper floor lamp', 'side-table': 'Small oak side table', rug: 'Woven wool rug' })[id], priceCents: price, currency: 'USD', url: 'https://example.com/item', domain: 'example.com', colors: ['#B98764'], materials: ['Wood', 'Linen'], dims: { w, d, h } });
const source = { query: 'small room', maxPrice: 30000, resultIds: ['chair'], retrievedAt: 1793952000000, cached: true, origin: 'recorded' };
function makeDesign(pass = false) {
  const values = [['reading-chair', 25000, pass ? 60 : 90, pass ? 60 : 90, 80, pass ? 335 : 300, pass ? 65 : 55, 270], ['floor-lamp', 6000, 30, 30, 150, 55, 255, 0], ['side-table', 7000, 40, 40, 50, 165, 260, 0], ['rug', 9000, 170, 120, 10, 190, 150, 0]];
  const design = { id: 'review-room', version: pass ? 2 : 1, mode: 'recorded', style: 'warm-reading', capturedAt: '2026-11-06', budgetCents: 60000, owned: OWNED_ITEMS.map(({ id, x, z, rot, locked }) => ({ id, x, z, rot, locked })), slots: values.map(([id, price, w, d, h, x, z, rot]) => ({ slot: id, pick: pick(id, price, w, d, h), by: 'recorded', reason: 'Soft fabric and warm wood for a small room.', placement: { x, z, rot }, alternates: [], source })), totals: { totalCents: 47000, budgetCents: 60000, overCents: 0, unverifiedCount: 0 }, labels: { search: 'recorded', ai: 'recorded' } };
  design.fit = checkFit(layoutOf(design), ROOM, DOOR, WINDOW, { budget: design.budgetCents, prices: Object.fromEntries(design.slots.map(s => [s.slot, s.pick.priceCents])) });
  if (!pass) design.slots[0].alternates = [{ candidate: { ...pick('reading-chair', 21000, 60, 60, 80), id: 'small-chair' }, fit: { passes: true, messages: [] }, priceDeltaCents: -4000 }];
  else { design.slots[0].pick.priceCents = 21000; design.totals.totalCents = 43000; design.swapNote = 'This chair clears the door and saves $40.00.'; }
  return design;
}
let design = makeDesign(); let quote; let receipt; let moveRefused = false; let scenesFail = false; let unknown = false; let moves = 0;
const errors = []; const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }); page.on('pageerror', error => errors.push(error.message));
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
    if (path === '/api/refund') { receipt.lines[0].refund = { state: 'completed', amountCents: 21000, paypalId: 'test-refund' }; receipt.plan[0].status = 'returned'; return json(receipt); }
    const files = { '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/styles.css': ['public/styles.css', 'text/css'], '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'] };
    if (files[path]) return route.fulfill({ contentType: files[path][1], body: await readFile(files[path][0]) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://room.test/'); await page.getByRole('button', { name: 'Swap for one that fits', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Freeze quote', exact: true }).isDisabled(), true);
  await page.screenshot({ path: 'src/client/review-desktop.png' });
  await page.getByRole('button', { name: 'Swap for one that fits', exact: true }).click(); await page.getByText('This chair clears the door and saves $40.00.').waitFor();
  assert.equal(design.fit.passes, true, JSON.stringify(design.fit.messages));
  assert.equal(await page.getByRole('button', { name: 'Freeze quote', exact: true }).isEnabled(), true);
  await page.locator('.pick').first().hover(); await page.waitForTimeout(100); assert.ok((await page.locator('.threads path').getAttribute('d')).length > 0);
  await page.getByRole('button', { name: 'Plan', exact: true }).click(); await page.waitForTimeout(750);
  const coordinate = async (x, z) => { const rect = await page.locator('#room canvas').boundingBox(); const aspect = rect.width / rect.height; const half = Math.max(215, 210 / aspect); return { x: rect.x + rect.width / 2 - (x - 190) / (half * aspect * 2) * rect.width, y: rect.y + rect.height / 2 - (z - 160) / (half * 2) * rect.height }; };
  let start = await coordinate(335, 65); let end = await coordinate(325, 65);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(200);
  assert.equal(moves, 1); assert.equal(design.slots[0].placement.x, 325);
  moveRefused = true; start = await coordinate(325, 65); end = await coordinate(315, 65);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up(); await page.getByText('This move was refused by the server.').waitFor(); assert.equal(moves, 2); assert.equal(design.slots[0].placement.x, 325);
  moveRefused = false; await page.getByRole('combobox', { name: 'Select movable furniture' }).selectOption('reading-chair'); await page.getByRole('button', { name: 'Rotate ↻', exact: true }).click(); await page.waitForTimeout(100); assert.equal(design.slots[0].placement.rot, 0);
  await page.screenshot({ path: 'src/client/review-plan.png' });
  await page.getByRole('button', { name: 'Walk', exact: true }).click(); await page.waitForTimeout(750); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Freeze quote', exact: true }).click(); await page.getByText('Frozen total $430.00').waitFor();
  unknown = true; await page.getByRole('button', { name: 'Pay with PayPal (sandbox)', exact: true }).click(); await page.getByText('Checking payment', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Pay with PayPal (sandbox)', exact: true }).count(), 0);
  await page.reload(); await page.getByText('Checking payment', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Pay with PayPal (sandbox)', exact: true }).count(), 0);
  receipt = { quote: { ...quote, state: 'paid' }, orderId: 'test-order', captureId: 'test-capture', capturedCents: 43000, refundedCents: 0, lines: quote.lines.map(line => ({ ...line, refund: null })), plan: quote.lines.map(line => ({ roomObjectId: line.roomObjectId, status: 'paid' })) };
  await page.evaluate(saved => sessionStorage.setItem('roomweft-payment-room', JSON.stringify(saved)), { quoteId: quote.id, design });
  await page.goto('http://room.test/?receipt=review-quote'); await page.getByText('Capture test-capture').waitFor(); await page.getByRole('button', { name: 'Refund this item', exact: true }).first().click(); await page.getByText('Refund completed', { exact: true }).waitFor();
  assert.equal(await page.getByText('The room plan and the receipt now differ. Freeze a new quote to buy a replacement.').count(), 1);
  await page.setViewportSize({ width: 360, height: 800 }); await page.screenshot({ path: 'src/client/review-phone.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'phone overflow');
  receipt.recorded = true; await page.reload(); await page.getByText('Recorded receipt, makes no payment', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Refund this item', exact: true }).first().isDisabled(), true);
  receipt = undefined; design.mode = 'rules'; design.labels.ai = 'rules'; await page.goto('http://room.test/'); await page.getByText('Picked by rules, no AI today', { exact: true }).waitFor();
  design.slots[0].pick.dims = null; design.fit.unverified = ['reading-chair']; design.totals.unverifiedCount = 1; await page.reload(); await page.locator('.pick .badge').filter({ hasText: 'Fit unverified' }).waitFor();
  scenesFail = true; await page.goto('http://room.test/'); await page.getByRole('button', { name: 'Retry', exact: true }).waitFor(); scenesFail = false; await page.getByRole('button', { name: 'Retry', exact: true }).click(); await page.getByRole('heading', { name: 'Your room' }).waitFor();
  assert.deepEqual(errors, []); console.log(JSON.stringify({ browser: 'passed', checks: ['initial failure blocks quote', 'swap clears fit and updates total', 'woven thread draws', 'accepted plan drag', 'refused plan drag', 'keyboard selection and rotation', 'plan and walk cameras', 'unknown capture blocks payment across reload', 'return restores room', 'refund and receipt', 'recorded receipt is read only', 'rules and unverified labels', '360px has no horizontal scroll', 'scene failure and retry'], pageErrors: errors }));
} finally { await browser.close(); }
