import { chromium } from 'playwright';
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { CONTENT_SECURITY_POLICY } from '../http/response.ts';
await mkdir('out/page-check', { recursive: true });
const bundle = await build({ stdin: { contents: "export * from './src/shared/room'; export * from './src/shared/fit'; export * from './src/client/helpers';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { OWNED_ITEMS, ROOM, DOOR, WINDOW, STYLES, layoutOf, checkFit, roomFromSpec } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const sceneBundle = await build({ stdin: { contents: "export * from './src/client/scene'; export * from './src/client/meshes'; export { Box3, Vector3 } from 'three';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm' });
const pick = (id, price, w, d, h) => ({ id, title: ({ 'reading-chair': 'Linen reading chair', 'floor-lamp': 'Warm paper floor lamp', 'side-table': 'Small oak side table', rug: 'Woven wool rug' })[id], priceCents: price, currency: 'USD', url: 'https://example.com/item', domain: 'example.com', colors: ['#B98764'], materials: ['Wood', 'Linen'], dims: { w, d, h } });
const source = { query: 'small room', maxPrice: 30000, resultIds: ['chair'], retrievedAt: 1793952000000, cached: true, origin: 'recorded' };
function makeDesign(pass = false) {
  const values = [['reading-chair', 25000, pass ? 60 : 86.4, pass ? 60 : 86.4, 80, pass ? 335 : 300, pass ? 65 : 55, 270], ['floor-lamp', 6000, 30, 30, 150, 55, 255, 0], ['side-table', 7000, 40, 40, 50, 165, 260, 0], ['rug', 9000, 170, 120, 10, 190, 150, 0]];
  const design = { id: 'review-room', version: pass ? 2 : 1, mode: 'recorded', style: 'calm-studio', capturedAt: '2026-11-06', budgetCents: 90000, owned: OWNED_ITEMS.map(({ id, x, z, rot, locked }) => ({ id, x, z, rot, locked })), slots: values.map(([id, price, w, d, h, x, z, rot]) => ({ slot: id, pick: pick(id, price, w, d, h), by: 'recorded', reason: 'Soft fabric and warm wood for a small room.', placement: { x, z, rot }, alternates: [], source })), totals: { totalCents: 47000, budgetCents: 90000, overCents: 0, unverifiedCount: 0 }, labels: { search: 'recorded', ai: 'recorded' } };
  design.brief = {text:'',by:'saved',understood:'Saved run: searched with the Calm studio words.',queries:STYLES[1].queries};
  design.fit = checkFit(layoutOf(design), ROOM, DOOR, WINDOW, { budget: design.budgetCents, prices: Object.fromEntries(design.slots.map(s => [s.slot, s.pick.priceCents])) });
  if (!pass) design.slots[0].alternates = [{ candidate: { ...pick('reading-chair', 21000, 60, 60, 80), id: 'small-chair' }, fit: { passes: true, messages: [] }, verified: true, priceDeltaCents: -4000 }];
  else { design.slots[0].pick.priceCents = 21000; design.totals.totalCents = 43000; design.swapNote = 'This chair clears the door and saves $40.00.'; }
  return design;
}
let lastDesignBody; const roomBodies = []; let design = makeDesign(); let quote; let receipt; let moveRefused = false; let scenesFail = false; let unknown = false; let moves = 0;
  let priceChange = false;
  let pageError; const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }); page.on('pageerror', error => { pageError = error; }); page.on('console', message => { if (message.text().includes('Content Security Policy')) pageError = new Error(message.text()); });
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname !== 'room.test') return route.abort();
    if (path === '/models/manifest.json') return route.fulfill({ contentType: 'application/json', body: await readFile('public/models/manifest.json') });
    if (/^\/models\/[a-z-]+\.glb$/.test(path)) return route.fulfill({ contentType: 'model/gltf-binary', body: await readFile(`public${path}`) });
    if (path === '/scene-check.js') return route.fulfill({ contentType: 'text/javascript', body: sceneBundle.outputFiles[0].text });
    if (path === '/api/scenes') return scenesFail ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The room service is unavailable.', code: 'offline' }) }) : json({});
    if (path === '/api/status') return json({ search: { live: true, remainingToday: 10 }, ai: { live: false, remainingNeuronsToday: 0 }, sandbox: { live: true }, visitor: { liveDesignsLeft: 3, checkoutsLeft: 6, refundsLeft: 6 } });
    if (path === '/api/design') { const body = request.postDataJSON(); lastDesignBody = body; assert.equal(body.style, 'calm-studio'); assert.equal(body.budget, 900); return json(design); }
    if (path.endsWith('/swap')) { design = makeDesign(true); return json(design); }
    if (path === '/api/room') {
      const body = request.postDataJSON(); roomBodies.push(body);
      const owned = roomFromSpec(body.roomSpec).ownedItems.map(({ id, x, z, rot, locked }) => ({ id, x, z, rot, locked }));
      design = { ...design, version: design.version + 1, roomSpec: body.roomSpec, owned }; return json(design);
    }
    if (path.endsWith('/move')) { moves++; if (moveRefused) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'locked', error: 'This move was refused by the server.' }) }); const body = request.postDataJSON(); design.slots.find(s => s.slot === body.itemId).placement = { x: body.x, z: body.z, rot: body.rot }; design.version++; return json(design); }
    if (path === '/api/quote') { quote = { id: 'review-quote', designId: design.id, designVersion: design.version, lines: design.slots.map(s => ({ lineId: s.slot, roomObjectId: s.slot, productId: s.pick.id, title: s.pick.title, priceCents: s.pick.priceCents, currency: 'USD', url: s.pick.url, domain: s.pick.domain, fitStatus: 'fits', source })), totalCents: design.totals.totalCents, state: 'open' }; return json(quote); }
    if (path === '/api/checkout') {
      if (priceChange) {
        priceChange = false; design.version++; design.slots[1].pick.priceCents += 1000; design.totals.totalCents += 1000;
        quote.state = 'stale'; quote.repriced = [{ lineId: 'floor-lamp', oldCents: 6000, newCents: 7000 }];
        quote.error = 'Prices changed at the shop. Freeze a new quote.';
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'price_changed', error: quote.error, quote, design }) });
      }
      if (request.postDataJSON().method === 'card') {
        quote.state = 'paid'; receipt = { quote, orderId: 'card-order', captureId: 'card-capture', capturedCents: 43000, refundedCents: 0, lines: quote.lines.map(line => ({ ...line, refund: null })), plan: quote.lines.map(line => ({ roomObjectId: line.roomObjectId, status: 'paid' })), events: [{ type: 'CHECKOUT.ORDER.APPROVED', receivedAt: 1793952000000 }, { type: 'PAYMENT.CAPTURE.COMPLETED', receivedAt: 1793952005000 }] }; return json(receipt);
      }
      quote.state = unknown ? 'capture_unknown' : 'approving'; return json(quote);
    }
    if (path.startsWith('/api/receipt/')) return json(receipt ?? { quote, orderId: null, captureId: null, capturedCents: 0, refundedCents: 0, lines: quote.lines.map(line => ({ ...line, refund: null })), plan: quote.lines.map(line => ({ roomObjectId: line.roomObjectId, status: 'paid' })), events: [] });
    if (path === '/api/refund') { receipt.lines[0].refund = { state: 'completed', amountCents: 21000, paypalId: 'test-refund' }; receipt.plan[0].status = 'returned'; return json({ id: 'test-refund-record', quoteId: quote.id, lineId: receipt.lines[0].lineId, amountCents: 21000, state: 'completed', paypalId: 'test-refund' }); }
    const files = { '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/styles.css': ['public/styles.css', 'text/css'], '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'] };
    if (files[path]) return route.fulfill({ contentType: files[path][1], body: await readFile(files[path][0]), headers: path === '/' ? { 'Content-Security-Policy': CONTENT_SECURITY_POLICY } : undefined });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://room.test/'); await page.getByRole('button', { name: 'Swap for one that fits', exact: true }).waitFor();
  await page.waitForFunction(() => window.__roomweftReady === true);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const summary = page.getByTestId('summary');
    assert.equal(await summary.isVisible(), true, `summary is visible at ${viewport.width}x${viewport.height}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${viewport.width}px has no sideways scroll`);
    const fixButton = summary.getByRole('button', { name: 'Fix the reading chair' });
    assert.equal(await fixButton.isVisible(), true, `fix button is visible at ${viewport.width}x${viewport.height}`);
    await fixButton.click();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'swap-reading-chair', `fix button moves focus to swap button at ${viewport.width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const modelChecks = await page.evaluate(async saved => {
    const { furniture, dispose, RoomScene, Box3 } = await import('/scene-check.js');
    const manifest = await (await fetch('/models/manifest.json')).json();
    const loadedKinds = [];
    for (const kind of manifest.kinds) {
      const id = ({armchair: 'reading-chair', 'arc-lamp': 'floor-lamp', 'square-table': 'side-table'})[kind] ?? kind;
      const title = kind === 'arc-lamp' ? 'Emry Arc Floor Lamp' : kind === 'side-table' ? 'Chiro Round Wood Side Table' : '';
      let root;
      await new Promise(resolve => { root = furniture({ id, kind, x: 0, z: 0, rot: 0, w: 32, d: 119, h: 173, source: 'slot', dims: 'verified', locked: false }, '#b98764', resolve, title); });
      if (root.userData.modelKind !== kind) throw new Error(`Model failed to load: ${kind}`);
      loadedKinds.push(root.userData.modelKind); dispose(root);
    }
    const host = document.createElement('div'); host.style.cssText = 'width:800px;height:600px;position:fixed;left:-900px'; document.body.append(host);
    const view = new RoomScene(host);
    try {
      view.update(saved, null);
      await new Promise(resolve => { const poll = () => [...view.objects].every(([id, root]) => id === 'rug' || root.userData.modelKind) ? resolve() : setTimeout(poll, 20); poll(); });
      const camera = view.walk.position;
      for (const [id, root] of view.objects) {
        const bounds = new Box3();
        root.traverse(child => { if (child.isMesh) bounds.union(new Box3().setFromObject(child)); });
        if (bounds.containsPoint(camera)) throw new Error(`Walk starts inside ${id}`);
        if (id !== 'rug' && Math.abs(bounds.min.y) > .01) throw new Error(`Model off floor: ${id}`);
      }
      return { loadedKinds, walkStart: camera.toArray(), grounded: true };
    } finally { view.destroy(); host.remove(); }
  }, design);
  assert.equal(modelChecks.loadedKinds.length, 8);
  console.log(JSON.stringify({ models: modelChecks }));
  for (const mode of ['Overview', 'Plan', 'Walk']) {
    await page.getByRole('button', { name: `${mode} view`, exact: true }).click();
    await page.waitForFunction(() => window.__roomweftReady === true); await page.waitForTimeout(750);
    await page.screenshot({ path: `out/page-check/review-models-${mode.toLowerCase()}.png` });
  }
  await page.getByRole('button', { name: 'Overview view', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Freeze quote', exact: true }).isDisabled(), true);
  assert.equal(await page.getByTestId('style-calm-studio').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByTestId('budget').inputValue(), '900');
  await page.getByRole('heading', {name:'What RoomWeft understood',exact:true}).waitFor();
  await page.getByText('Saved run: searched with the Calm studio words.',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('brief-understood').getAttribute('data-by'), 'saved');
  const searchDetails = page.getByTestId('brief-understood').locator('details');
  assert.equal(await searchDetails.locator('summary').innerText(), 'Search details', 'details summary is Search details');
  assert.equal(await searchDetails.evaluate(node => node.open), false, 'search details closed by default');
  await searchDetails.locator('summary').click();
  assert.equal(await searchDetails.evaluate(node => node.open), true, 'search details open on click');
  for (const query of Object.values(STYLES[1].queries)) await page.getByText(`Searched: ${query}`,{exact:true}).waitFor();
  const roomBrief = 'I read in the evening, under $700';
  await page.getByRole('textbox',{name:'Tell RoomWeft about the room'}).fill(roomBrief);
  await page.getByTestId('search-live').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="search-live"]')?.disabled === false);
  assert.equal(lastDesignBody.brief, roomBrief); assert.equal(lastDesignBody.live, true);
  assert.equal(await page.getByRole('textbox',{name:'Tell RoomWeft about the room'}).inputValue(),roomBrief);
  assert.ok((await page.locator('#room-finding').innerText()).includes('door swing'));
  assert.equal(await page.getByTestId('pay-card').count(), 1);
  assert.equal(await page.locator('#rotate').isVisible(), false);
  assert.equal(await page.locator('#panel .pick .amber').filter({ hasText: '86 cm at its narrowest, 80 cm door: tight to bring in' }).count(), 1);
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.locator('.room-caption').evaluate(caption => { const a = caption.getBoundingClientRect(); const b = document.querySelector('.view-modes').getBoundingClientRect(); return a.top >= b.bottom || a.left >= b.right; }), true, 'caption clears view buttons');
    if (width === 360 || width === 390) {
      assert.equal(await page.locator('.room-caption').evaluate(caption => {
        const a = caption.getBoundingClientRect();
        const canvas = document.querySelector('#room canvas').getBoundingClientRect();
        return a.top >= canvas.bottom || a.bottom <= canvas.top || a.left >= canvas.right || a.right <= canvas.left;
      }), true, 'caption does not overlap canvas');
    }
    await page.screenshot({ path: `out/page-check/review-opening-${width}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const stickyLink = page.getByRole('link', { name: 'Picks and basket' });
  assert.equal(await stickyLink.isVisible(), true, 'sticky link is visible on first load');
  await stickyLink.click();
  const picksHeading = page.getByRole('heading', { name: 'Picks' });
  await picksHeading.waitFor();
  assert.equal(await picksHeading.evaluate(node => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  }), true, 'picks heading comes into view');
  await page.waitForFunction(() => document.querySelector('#phone-jump')?.hidden === true);
  assert.equal(await stickyLink.isVisible(), false, 'sticky link is hidden when picks is on screen');
  const backToRoom = page.getByRole('link', { name: 'Back to room' });
  await backToRoom.click();
  await page.waitForFunction(() => document.querySelector('#phone-jump')?.hidden === false);
  assert.equal(await page.locator('#room').evaluate(node => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  }), true, 'room view is brought back');
  assert.equal(await stickyLink.isVisible(), true, 'sticky link visible again when room is back');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'out/page-check/review-walkway-overview.png' });
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
  moveRefused = false;
  const keyboardDetails = page.locator('.plan-tools details');
  assert.equal(await keyboardDetails.count(), 1, 'keyboard details inside plan tools on desktop');
  assert.equal(await keyboardDetails.evaluate(node => node.open), false, 'keyboard details closed on desktop');
  assert.equal(await keyboardDetails.locator('summary').innerText(), 'Keyboard', 'details summary is Keyboard');
  assert.equal(await page.getByRole('combobox', { name: 'Select movable furniture' }).isVisible(), false, 'plan tools closed by default');
  await keyboardDetails.locator('summary').click();
  assert.equal(await keyboardDetails.evaluate(node => node.open), true, 'keyboard details open on click');
  assert.equal(await page.getByRole('combobox', { name: 'Select movable furniture' }).isVisible(), true, 'plan tools visible when open');
  await page.getByRole('combobox', { name: 'Select movable furniture' }).selectOption('reading-chair'); await page.getByRole('button', { name: 'Rotate ↻', exact: true }).click(); await page.waitForTimeout(100); assert.equal(design.slots[0].placement.rot, 0);
  await page.screenshot({ path: 'out/page-check/review-plan.png' });
  await page.getByRole('button', { name: 'Walk view', exact: true }).click(); await page.waitForTimeout(750); await page.screenshot({ path: 'out/page-check/review-walkway-walk.png' }); await page.screenshot({ path: 'out/page-check/review-walk.png' }); await page.locator('#room canvas').focus(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Freeze quote', exact: true }).click(); await page.getByText('Frozen total $430.00').waitFor();
  await page.getByTestId('pay-card').click(); await page.getByText('Capture card-capture').waitFor();
  await page.getByTestId('receipt').getByText('Paid with PayPal', { exact: true }).waitFor();
  await page.getByTestId('receipt').getByText('Payment captured', { exact: true }).waitFor();
  await page.getByTestId('receipt').getByText('Signature verified', { exact: true }).first().waitFor();
  assert.equal(await page.locator('#receipt').evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.top < innerHeight; }), true);
  {
    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
    for (const phrase of ['sandbox', 'test money', 'test card', 'nothing ships']) {
      assert.equal(bodyText.includes(phrase), false, `document.body.innerText contains "${phrase}" after card payment`);
    }
  }
  receipt = undefined; await page.getByTestId('freeze-quote').click(); await page.getByText('Frozen total $430.00').waitFor();
  unknown = true; await page.getByRole('button', { name: 'Pay with PayPal', exact: true }).click(); await page.getByText('Checking payment', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Pay with PayPal', exact: true }).count(), 0);
  await page.reload(); await page.getByText('Checking payment', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Pay with PayPal', exact: true }).count(), 0);
  receipt = { quote: { ...quote, state: 'paid' }, orderId: 'test-order', captureId: 'test-capture', capturedCents: 43000, refundedCents: 0, lines: quote.lines.map(line => ({ ...line, refund: null })), plan: quote.lines.map(line => ({ roomObjectId: line.roomObjectId, status: 'paid' })), events: [{ type: 'CHECKOUT.ORDER.APPROVED', receivedAt: 1793952000000 }, { type: 'PAYMENT.CAPTURE.COMPLETED', receivedAt: 1793952005000 }] };
  await page.evaluate(saved => sessionStorage.setItem('roomweft-payment-room', JSON.stringify(saved)), { quoteId: quote.id, design });
  await page.goto('http://room.test/?receipt=review-quote'); await page.getByText('Capture test-capture').waitFor(); await page.getByText('Paid with PayPal', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Refund this item', exact: true }).first().click(); await page.getByText('Refund completed', { exact: true }).waitFor(); await page.getByText('Returned', { exact: true }).waitFor();
  await page.reload(); await page.getByText('Paid with PayPal', { exact: true }).waitFor(); await page.getByText('Returned', { exact: true }).waitFor();
  assert.equal(await page.getByText('The room plan and the receipt now differ. Replace the returned piece with a one piece quote.').count(), 1);
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
    if (viewport.width < 700) {
      assert.equal(await page.locator('.plan-tools details').count(), 0, `${viewport.width}px keeps row open with no details`);
    } else {
      assert.equal(await page.locator('.plan-tools details').count(), 1, `${viewport.width}px has keyboard details`);
    }
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
  assert.equal(await page.locator('#receipt').getByRole('heading', { name: 'PayPal events' }).count(), 0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  receipt = undefined; design.mode = 'rules'; design.labels.ai = 'rules'; await page.goto('http://room.test/'); await page.getByText('Picked by rules, no AI today', { exact: true }).waitFor();
  design.slots[0].pick.dims = null; design.slots[0].pick.hasMeasurements = true; design.slots[3].pick.dims = null; design.fit.unverified = ['reading-chair', 'rug']; design.totals.unverifiedCount = 2; await page.reload(); await page.locator('.pick .badge').filter({ hasText: 'Fit unverified' }).first().waitFor();
  await page.getByTestId('slot-rug').getByText('Size not listed', { exact: true }).waitFor();
  await page.getByTestId('slot-reading-chair').getByText('Size not usable from the listing', { exact: true }).waitFor();
  await page.getByTestId('slot-reading-chair').hover();
  await page.getByText('Size not usable from the listing, fit unverified', { exact: false }).waitFor();
  const statuses = await page.evaluate(async saved => {
    const { RoomScene } = await import('/scene-check.js');
    const host = document.createElement('div'); host.style.cssText = 'width:800px;height:600px;position:fixed;left:-900px'; document.body.append(host);
    const view = new RoomScene(host);
    try {
      view.update(saved, { plan: [{ roomObjectId: 'reading-chair', status: 'returned' }] });
      return ['Overview', 'Walk', 'Plan'].map(mode => {
        view.setMode(mode);
        const sprites = []; view.pieces.traverse(child => { if (child.isSprite && child.visible) sprites.push(child.name); });
        const returned = view.objects.get('reading-chair');
        const opacity = []; returned.traverse(child => { if (child.isMesh) opacity.push(child.material.opacity); });
        const edges = view.regions.children.filter(child => child.userData.walkwayEdge);
        const planDots = view.regions.children.filter(child => child.userData.walkwayPlan);
        const floorDots = view.regions.children.filter(child => child.userData.walkwayDot);
        return { mode, sprites, opacity, outlines: view.regions.children.map(child => child.name), walkwayEdges: edges.length, visibleWalkwayEdges: edges.filter(child => child.visible).length, planDots: planDots.length, visiblePlanDots: planDots.filter(child => child.visible).length, floorDots: floorDots.length, visibleFloorDots: floorDots.filter(child => child.visible).length, floorDotRadius: floorDots[0]?.geometry.parameters.radius, floorDotDepthTest: floorDots[0]?.material.depthTest };
      });
    } finally { view.destroy(); host.remove(); }
  }, design);
  for (const status of statuses) {
    assert.ok(status.walkwayEdges > 0, `${status.mode} has walkway edge meshes`);
    assert.equal(status.visibleWalkwayEdges > 0, status.mode !== 'Plan', `${status.mode} walkway edge visibility`);
    assert.ok(status.planDots > 0, `${status.mode} has Plan dots`);
    assert.equal(status.visiblePlanDots > 0, status.mode === 'Plan', `${status.mode} Plan dot visibility`);
    assert.ok(status.floorDots > 0, `${status.mode} has overview and Walk dots`);
    assert.equal(status.visibleFloorDots > 0, status.mode !== 'Plan', `${status.mode} floor dot visibility`);
    assert.equal(status.floorDotRadius, 4, `${status.mode} floor dot radius`);
    assert.equal(status.floorDotDepthTest, true, `${status.mode} floor dots are hidden by furniture`);
    assert.equal(status.sprites.includes('Fit unverified'), status.mode === 'Plan', `${status.mode} unverified sprite`);
    assert.equal(status.sprites.includes('Returned'), status.mode === 'Plan', `${status.mode} returned sprite`);
    assert.ok(status.opacity.length && status.opacity.every(value => value === .3), 'returned piece stays translucent');
    assert.ok(status.outlines.includes('floor-reading-chair') && status.outlines.includes('floor-rug'), 'status floor outlines stay present');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const mode of ['Plan', 'Overview', 'Walk']) {
    await page.getByRole('button', { name: `${mode} view`, exact: true }).click();
    await page.waitForFunction(() => window.__roomweftReady === true);
    await page.waitForTimeout(750);
    assert.equal(await page.locator('#room canvas').evaluate(canvas => canvas.style.transform), mode === 'Plan' ? 'scaleX(-1)' : '');
    await page.screenshot({ path: `out/page-check/review-unverified-${mode.toLowerCase()}.png` });
  }
  receipt = undefined; quote = undefined; unknown = false; design = makeDesign(true);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto('http://room.test/');
  await page.getByTestId('freeze-quote').click(); await page.getByText('Frozen total $430.00').waitFor();
  priceChange = true; await page.getByTestId('pay-card').click();
  await page.getByText('Floor lamp: $60.00 \u2192 $70.00', { exact: true }).waitFor();
  assert.ok((await page.locator('#panel').innerText()).includes('Prices changed at the shop. Freeze a new quote.'));
  await page.locator('.total').filter({ hasText: '$440.00 of $900.00' }).waitFor();
  assert.ok((await page.getByTestId('summary').innerText()).includes('$440.00 of $900.00'));
  assert.equal(await page.getByTestId('pay-card').isDisabled(), true);
  assert.equal(await page.getByTestId('freeze-quote').isEnabled(), true);
  await page.getByTestId('freeze-quote').click(); await page.getByText('Frozen total $440.00').waitFor();
  await page.getByTestId('pay-card').click(); await page.getByText('Capture card-capture').waitFor();
  scenesFail = true; await page.goto('http://room.test/'); await page.getByRole('button', { name: 'Retry', exact: true }).waitFor(); scenesFail = false; await page.getByRole('button', { name: 'Retry', exact: true }).click(); await page.getByRole('heading', { name: 'Your room' }).waitFor();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); design = makeDesign(true); roomBodies.length = 0;
    await page.goto('http://room.test/'); await page.waitForFunction(() => window.__roomweftReady === true);
    await page.getByRole('button', { name: 'Plan view', exact: true }).click(); await page.waitForTimeout(400);
    const before = await page.getByTestId('plan-floor').boundingBox();
    assert.ok(Math.abs(before.width / before.height - 380 / 320) < .03, `sample plan is 380 by 320 at ${viewport.width}`);
    assert.equal(await page.getByTestId('room-size').isVisible(), true);
    await page.getByTestId('room-width').fill('150'); await page.getByTestId('room-apply').click();
    await page.locator('#room-field-width-error').waitFor();
    assert.equal(await page.locator('#room-field-width-error').innerText(), 'Use a width from 200 to 800 cm.');
    assert.equal(await page.locator('#room-field-width-error').getAttribute('data-testid'), 'room-error');
    assert.equal(roomBodies.length, 0, 'a bad width is not sent');
    await page.getByTestId('room-width').fill('300'); await page.getByTestId('room-depth').fill('280'); await page.getByTestId('door-left').fill('140');
    const answer = page.waitForResponse(response => new URL(response.url()).pathname === '/api/room');
    await page.getByTestId('room-apply').click(); await answer;
    await page.waitForFunction(() => window.__roomweftReady === true); await page.waitForTimeout(500);
    assert.deepEqual(roomBodies.at(-1).roomSpec, { width: 300, depth: 280, door: { left: 140, width: 80 }, owned: { desk: { w: 120, d: 60, h: 75 }, deskChair: { w: 55, d: 55, h: 90 }, bookshelf: { w: 80, d: 30, h: 180 } } });
    const after = await page.getByTestId('plan-floor').boundingBox();
    assert.ok(Math.abs(after.width / after.height - 300 / 280) < .03, `plan redraws to 300 by 280 at ${viewport.width}: ${after.width}x${after.height}`);
    assert.equal(await page.getByTestId('room-width').inputValue(), '300');
    assert.equal(await page.getByTestId('room-dimensions').innerText(), '300 x 280 cm');
    assert.equal(await page.getByTestId('room-error').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${viewport.width}px has no sideways scroll after a room change`);
    await page.screenshot({ path: `out/page-check/room-size-${viewport.width}.png` });
    await page.getByTestId('room-size').screenshot({ path: `out/page-check/room-size-box-${viewport.width}.png` });
  }
  {
    // The drag preview must judge the measured room, not the sample room.
    await page.setViewportSize({ width: 1440, height: 900 }); design = makeDesign(true);
    await page.goto('http://room.test/'); await page.waitForFunction(() => window.__roomweftReady === true);
    await page.getByRole('button', { name: 'Plan view', exact: true }).click(); await page.waitForTimeout(400);
    await page.getByTestId('room-width').fill('450'); await page.getByTestId('room-depth').fill('360');
    const answer = page.waitForResponse(response => new URL(response.url()).pathname === '/api/room');
    await page.getByTestId('room-apply').click(); await answer;
    await page.waitForFunction(() => window.__roomweftReady === true); await page.waitForTimeout(500);
    const chair = design.slots[0].placement;
    const at = async (x, z) => { const rect = await page.getByTestId('plan-floor').boundingBox(); return { x: rect.x + x / 450 * rect.width, y: rect.y + (1 - z / 360) * rect.height }; };
    const from = await at(chair.x, chair.z); const to = await at(chair.x - 10, chair.z);
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 5 }); await page.waitForTimeout(150);
    const outside = await page.locator('canvas').first().getAttribute('data-fit-outside');
    await page.mouse.up(); await page.waitForTimeout(200);
    assert.equal(outside, '', `drag preview in a 450 by 360 room puts nothing outside the walls, got "${outside}"`);
  }
  {
    await page.setViewportSize({ width: 390, height: 844 });
    design = makeDesign(true);
    await page.goto('http://room.test/');
    await page.waitForFunction(() => window.__roomweftReady === true);
    const card = page.locator('.pick').first();
    await card.scrollIntoViewIfNeeded();
    const roomBottom = await page.locator('#room canvas').evaluate(node => node.getBoundingClientRect().bottom);
    assert.ok(roomBottom <= 0, `room canvas must be fully above the window, got bottom=${roomBottom}`);
    await card.locator('[data-object]').first().click();
    await page.waitForTimeout(200);
    const d = await page.locator('.threads path').getAttribute('d');
    assert.equal(d, '', `thread path d must be empty when room is off screen, got "${d}"`);
  }
  assert.equal(pageError, undefined, pageError?.message ?? 'page error'); console.log(JSON.stringify({ browser: 'passed', checks: ['drag preview judges the measured 450 by 360 room', 'room size applies 300 by 280, refuses a bad width and redraws the plan at 1440 and 390', 'summary visible and fix button focus at 1440 and 390', 'saved brief and four saved queries on first screen', 'live search sends the room brief', 'price change refreshes totals and permits a new quote and payment', 'Calm studio opens at $900 with red caption and card button', 'card payment loads and scrolls receipt', 'no sandbox or test words on screen after card payment', 'caption clears controls at phone widths', 'initial failure blocks quote', 'swap clears fit and updates total', 'woven thread draws', 'accepted plan drag', 'refused plan drag', 'keyboard selection and rotation', 'plan labels across cameras', 'plan fits free rectangle at 360, 390, 768 and 1440px', 'clear walk start', 'checkout return top and basket notices', 'unknown capture blocks payment across reload', 'return restores room', 'refund and receipt', 'recorded receipt is read only', 'rules and unverified labels', '360px has no horizontal scroll', 'scene failure and retry', 'phone jump links at 390px', 'plan tools keyboard details on desktop', 'thread hidden when the room is off screen at 390'], pageErrors: [] }));
} finally { await browser.close(); }
