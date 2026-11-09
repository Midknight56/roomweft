import assert from 'node:assert/strict';
import { approveBuyer, BuyerChallenge } from '../../tools/buyer.mjs';
import { ready, designResponse, dragRoomObject, swapFailure, launchBrowser } from '../../tools/browser-helpers.mjs';

const base = new URL(process.argv[2] || 'http://127.0.0.1:8787');
let browser, context, page, design, quote, receipt, refund, blocked = false, failures = 0;
async function step(number, title, action) {
  if (blocked) { console.log(`FAIL ${number}. ${title}: blocked by an earlier step.`); failures++; return; }
  try { await action(); console.log(`PASS ${number}. ${title}`); }
  catch (error) {
    if (process.env.E2E_DEBUG) console.error(error);
    console.log(`FAIL ${number}. ${title}: ${error instanceof BuyerChallenge ? 'A person must complete the sandbox security challenge.' : 'Required state or control was not reached.'}`);
    failures++; blocked = true;
  }
}
async function responseAfter(path, action) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
  const [result] = await Promise.all([response, action()]);
  if (!result.ok() && process.env.E2E_DEBUG) console.error(path, result.status(), await result.text());
  assert.ok(result.ok(), 'API request must succeed.'); return result.json();
}
async function freezeAndPay(beforePay) {
  for (let attempt = 0; attempt < 2; attempt++) {
    quote = await responseAfter('/api/quote', () => page.getByTestId('freeze-quote').click());
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/checkout');
    if (beforePay) await beforePay();
    await page.getByTestId('pay').click();
    const checkout = await response; const answer = await checkout.json();
    if (attempt === 0 && checkout.status() === 409 && answer.code === 'price_changed') { design = answer.design; continue; }
    assert.ok(checkout.ok()); return answer;
  }
}

try {
  browser = await launchBrowser();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  await step(1, 'Recorded room and four picks', async () => {
    design = await designResponse(page, () => page.goto(base.href)); await ready(page);
    assert.equal(design.mode, 'recorded'); assert.equal(design.style, 'calm-studio');
    assert.match(await page.getByTestId('mode-label').innerText(), /Saved live run/);
    assert.equal(await page.locator('[data-testid^="slot-"]').count(), 4);
  });
  await step(2, 'Swap clears fit and increases version', async () => { design = await swapFailure(page, design); });
  await step(3, 'Plan drag finds walkway and keeps desk locked', async () => {
    await page.getByTestId('mode-plan').click();
    const initial = design.owned.find(item => item.id === 'bookshelf');
    design = await designResponse(page, () => dragRoomObject(page, 'bookshelf', 260, 155));
    assert.match(design.fit.messages.join(' '), /walkway/i);
    design = await designResponse(page, () => dragRoomObject(page, 'bookshelf', initial.x, initial.z));
    assert.ok(!design.fit.messages.some(message => /walkway/i.test(message)));
    const desk = design.owned.find(item => item.id === 'desk');
    const target = page.locator('[data-object-id="desk"], [data-testid="room-object-desk"], [aria-label="Desk"]').first();
    const before = await target.boundingBox(); await dragRoomObject(page, 'desk', 190, 160);
    const after = await target.boundingBox(); assert.deepEqual(after, before);
    // Also verify that the server refuses the same movement.
    const refused = await context.request.post(new URL(`/api/design/${design.id}/move`, base).href, { data: { itemId: 'desk', x: 190, z: 160, rot: desk.rot } });
    assert.equal(refused.status(), 400);
    await page.getByTestId('mode-overview').click();
  });
  await step('4a', 'Test card pay creates a paid receipt with no login', async () => {
    const cardContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const cardPage = await cardContext.newPage();
      let room = await designResponse(cardPage, () => cardPage.goto(base.href)); await ready(cardPage);
      room = await swapFailure(cardPage, room);
      let frozen, sale;
      for (let attempt = 0; attempt < 2; attempt++) {
        const frozenResponse = cardPage.waitForResponse(response => new URL(response.url()).pathname === '/api/quote');
        await cardPage.getByTestId('freeze-quote').click(); frozen = await (await frozenResponse).json();
        const paymentResponse = cardPage.waitForResponse(response => new URL(response.url()).pathname === '/api/checkout');
        await cardPage.getByTestId('pay-card').click(); const payment = await paymentResponse;
        sale = await payment.json();
        if (attempt === 0 && payment.status() === 409 && sale.code === 'price_changed') { room = sale.design; continue; }
        assert.ok(payment.ok()); break;
      }
      assert.equal(sale.quote.id, frozen.id); assert.equal(sale.quote.state, 'paid'); assert.ok(sale.orderId); assert.ok(sale.captureId);
      assert.equal(sale.lines.length, room.slots.filter(slot => slot.pick).length);
      assert.ok(sale.lines.every(line => room.slots.some(slot => slot.slot === line.roomObjectId && slot.pick.id === line.productId)));
      await cardPage.getByTestId('receipt').getByText('Paid with PayPal', { exact: true }).waitFor();
      const text = await cardPage.getByTestId('receipt').innerText(); assert.ok(text.includes(sale.orderId)); assert.ok(text.includes(sale.captureId));
      assert.equal(new URL(cardPage.url()).origin, base.origin);
    } finally { await cardContext.close(); }
  });
  await step(4, 'Sandbox pay creates a linked paid receipt', async () => {
    // Use this visitor's context so the return keeps ownership of the frozen quote.
    const checkout = await freezeAndPay();
    const finalUrl = await approveBuyer(page, checkout.approveUrl, { email: process.env.PAYPAL_SANDBOX_BUYER_EMAIL, password: process.env.PAYPAL_SANDBOX_BUYER_PASSWORD });
    assert.ok(!/(^|\.)paypal\.com$/i.test(new URL(finalUrl).hostname)); await ready(page);
    await page.getByTestId('receipt').waitFor();
    const response = await context.request.get(new URL(`/api/receipt/${quote.id}`, base).href); assert.ok(response.ok()); receipt = await response.json();
    assert.equal(receipt.quote.state, 'paid'); assert.ok(receipt.orderId); assert.ok(receipt.captureId);
    assert.ok(receipt.lines.length); assert.ok(receipt.lines.every(line => receipt.plan.some(item => item.roomObjectId === line.roomObjectId)));
    const text = await page.getByTestId('receipt').innerText(); assert.ok(text.includes(receipt.orderId)); assert.ok(text.includes(receipt.captureId)); assert.match(text, /paid/i);
  });
  await step(5, 'One refund completes and object becomes Returned', async () => {
    const line = receipt.lines[0];
    refund = await responseAfter('/api/refund', () => page.getByTestId(`refund-${line.lineId}`).click());
    assert.ok(['pending', 'completed'].includes(refund.state));
    const deadline = Date.now() + 60000;
    do {
      const response = await context.request.get(new URL(`/api/receipt/${quote.id}`, base).href); receipt = await response.json();
      if (receipt.lines.find(item => item.lineId === line.lineId)?.refund?.state === 'completed') break;
      await page.waitForTimeout(1500);
    } while (Date.now() < deadline);
    assert.equal(receipt.lines.find(item => item.lineId === line.lineId).refund.state, 'completed');
    assert.equal(receipt.plan.find(item => item.roomObjectId === line.roomObjectId).status, 'returned');
    await page.reload(); await ready(page); assert.match(await page.getByTestId('receipt').innerText(), /Returned/);
  });
  await step(6, 'Repeated refund returns the original refund', async () => {
    const response = await context.request.post(new URL('/api/refund', base).href, { data: { quoteId: quote.id, lineId: refund.lineId } });
    assert.ok(response.ok()); const repeated = await response.json(); assert.equal(repeated.id, refund.id); assert.equal(repeated.paypalId, receipt.lines.find(item => item.lineId === refund.lineId).refund.paypalId);
  });
  await step('6a', 'Replace the returned piece with a one piece quote paid by test card', async () => {
    const returnedLine = receipt.lines.find(item => item.lineId === refund.lineId);
    let answer, paid; let trigger = () => page.getByTestId('replace-item').first().click();
    // A saved price older than six hours is checked with the shop first; a changed price asks for a new replacement quote.
    // The sandbox also declines a test card now and then; a declined replacement leaves room for a fresh one.
    for (let attempt = 0; attempt < 3; attempt++) {
      answer = await responseAfter('/api/replace', trigger);
      assert.equal(answer.quote.lines.length, 1); assert.equal(answer.quote.lines[0].lineId, refund.lineId);
      assert.notEqual(answer.quote.lines[0].productId, returnedLine.productId);
      assert.deepEqual(answer.quote.replaces, { quoteId: quote.id, lineId: refund.lineId });
      await page.getByTestId('replacement-quote').waitFor();
      const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/checkout' && item.request().method() === 'POST');
      await page.getByTestId('pay-card').click(); const checkout = await response; paid = await checkout.json();
      if (checkout.status() === 409 && paid.code === 'price_changed') { await page.getByTestId('replace-again').waitFor(); trigger = () => page.getByTestId('replace-again').click(); continue; }
      assert.ok(checkout.ok(), 'The replacement payment must answer.');
      if (paid.quote.state === 'paid') break;
      await page.getByTestId('open-first-receipt').click(); await page.getByTestId('replace-item').first().waitFor();
      trigger = () => page.getByTestId('replace-item').first().click();
    }
    assert.equal(paid.quote.state, 'paid'); assert.equal(paid.lines.length, 1); assert.equal(paid.quote.replaces.quoteId, quote.id);
    assert.equal(paid.capturedCents, answer.quote.totalCents);
    await page.getByTestId('replacement-receipt').waitFor();
    assert.ok((await page.getByTestId('replacement-receipt').innerText()).includes(quote.id.slice(0, 8)));
    const first = await (await context.request.get(new URL(`/api/receipt/${quote.id}`, base).href)).json();
    assert.deepEqual(first.lines, receipt.lines); assert.deepEqual(first.plan, receipt.plan);
    assert.equal(first.replacements.find(item => item.lineId === refund.lineId).state, 'paid');
  });
  await step(7, 'Another visitor cannot open the receipt', async () => {
    const other = await browser.newContext();
    try {
      const otherPage = await other.newPage(); const result = otherPage.waitForResponse(response => new URL(response.url()).pathname === `/api/receipt/${quote.id}`);
      await otherPage.goto(new URL(`/?receipt=${encodeURIComponent(quote.id)}`, base).href);
      assert.equal((await result).status(), 404); assert.match(await otherPage.locator('body').innerText(), /not found/i);
    } finally { await other.close(); }
  });
  await step(8, 'Cancelled approval keeps the design', async () => {
    await page.goto(base.href); await ready(page);
    design = await designResponse(page, () => page.getByTestId('style-warm-reading').click());
    design = await swapFailure(page, design);
    let saved;
    const checkout = await freezeAndPay(async () => {
      saved = JSON.stringify(await page.evaluate(() => ({ ...localStorage })));
    });
    const token = new URL(checkout.approveUrl).searchParams.get('token'); assert.ok(token);
    await page.goto(checkout.approveUrl);
    await page.goto(new URL(`/cancel?token=${encodeURIComponent(token)}`, base).href); await ready(page);
    await page.getByText('Payment was cancelled.').waitFor();
    assert.equal(JSON.stringify(await page.evaluate(() => ({ ...localStorage }))), saved);
    assert.equal(await page.locator('[data-testid^="slot-"]').count(), 4);
  });
} catch {
  for (let number = 1; number <= 8; number++) console.log(`FAIL ${number}. Browser setup failed.`);
  failures += 8;
}
finally { await context?.close(); await browser?.close(); }
process.exitCode = failures ? 1 : 0;
