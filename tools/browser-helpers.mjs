import assert from 'node:assert/strict';
import { chromium } from 'playwright';
export function launchBrowser() {
  return chromium.launch({ headless: true, ...(process.env.ROOMWEFT_BROWSER_CHANNEL ? { channel: process.env.ROOMWEFT_BROWSER_CHANNEL } : {}) });
}
export function visitorCookies(origin, visitor) {
  if (!visitor) return [];
  if (!/^[a-f\d]{32}$/i.test(visitor)) throw new Error('Use a valid visitor id.');
  return [{ name: 'rw_vid', value: visitor, url: new URL('/', origin).href, httpOnly: true, secure: true, sameSite: 'Lax' }];
}
export async function ready(page, timeout = 20000) {
  await page.waitForFunction(() => window.__roomweftReady === true, undefined, { timeout });
}
export function designResponse(page, action, timeout = 20000) {
  const response = page.waitForResponse(response => /\/api\/design(?:\/[^/]+\/(?:swap|move|lock))?$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST', { timeout });
  return Promise.all([response, action()]).then(async ([result]) => {
    assert.ok(result.ok(), 'Design request must succeed.');
    return result.json();
  });
}
export async function dragRoomObject(page, id, x, z) {
  const item = page.locator(`[data-object-id="${id}"], [data-testid="room-object-${id}"], [aria-label="${id === 'bookshelf' ? 'Bookshelf' : 'Desk'}"]`).first();
  const floor = page.locator('[data-testid="plan-floor"], [data-room-width="380"]').first();
  const [from, bounds] = await Promise.all([item.boundingBox(), floor.boundingBox()]);
  assert.ok(from && bounds, 'Plan must expose room object targets and the floor bounds.');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  try { await page.mouse.move(bounds.x + x / 380 * bounds.width, bounds.y + (1 - z / 320) * bounds.height, { steps: 16 }); }
  finally { await page.mouse.up(); }
}
export async function swapFailure(page, design) {
  if (design.fit.passes) return design;
  let choices = design.slots.filter(slot => slot.alternates.some(alt => alt.fit.passes));
  // The saved default basket exceeds $600. Give the swap room to isolate the geometric failure.
  if (!choices.length && design.totals.overCents > 0) {
    design = await designResponse(page, async () => {
      const budget = page.getByRole('spinbutton', { name: /budget/i });
      await budget.fill('1500'); await budget.press('Tab');
    });
    choices = design.slots.filter(slot => slot.alternates.some(alt => alt.fit.passes));
  }
  assert.ok(choices.length, 'A failing recorded pick needs a passing swap.');
  const next = await designResponse(page, () => page.getByTestId(`swap-${choices[0].slot}`).click());
  assert.ok(next.version > design.version, 'Swap must increase the version.');
  assert.ok(next.fit.passes, 'Swap must clear the failure.');
  return next;
}
