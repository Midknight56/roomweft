import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ready, designResponse, swapFailure, launchBrowser, visitorCookies } from './browser-helpers.mjs';
import { pathToFileURL } from 'node:url';

// This function is sent to the page and has no Node dependencies.
export function measureControls() {
  const failures = [];
  const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
  const controls = document.querySelectorAll('button, input:not([type="hidden"]), select, textarea, a[href], [role="button"], [tabindex="0"]');
  for (const control of controls) {
    if (!visible(control)) continue;
    const box = control.getBoundingClientRect();
    const name = control.getAttribute('data-testid') || control.getAttribute('aria-label') || control.textContent.trim().slice(0, 60) || control.tagName;
    if (box.left < 16 || box.right > innerWidth - 16) failures.push({ control: name, problem: 'Control needs 16 px at the viewport sides.' });
    // Elements below the fold are expected. Only visible vertical edges are measured.
    if (box.bottom > 0 && box.top < innerHeight && (box.top < 16 || box.bottom > innerHeight - 16)) failures.push({ control: name, problem: 'Control needs 16 px at the visible viewport edges.' });
    if (control.matches('button, [role="button"]')) {
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        for (const text of range.getClientRects()) {
          if (text.left < box.left + 8 - 0.5 || text.right > box.right - 8 + 0.5 || text.top < box.top + 8 - 0.5 || text.bottom > box.bottom - 8 + 0.5) {
            failures.push({ control: name, problem: 'Button text needs 8 px padding.' }); break;
          }
        }
      }
    }
  }
  if (document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth) failures.push({ control: 'page', problem: 'Horizontal scroll.' });
  return failures;
}
export async function takeShots(baseUrl, outDir) {
  const base = new URL(baseUrl); const output = resolve(outDir);
  await mkdir(output, { recursive: true });
  const browser = await launchBrowser();
  const failures = [];
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      await context.addCookies(visitorCookies(base.href, process.env.ROOMWEFT_VISITOR_ID));
      const page = await context.newPage();
      const shot = async name => {
        await ready(page);
        await page.evaluate(() => document.fonts.ready);
        const file = `${viewport.width}-${name}.png`;
        await page.screenshot({ path: resolve(output, file), fullPage: true });
        for (const failure of await page.evaluate(measureControls)) failures.push({ screen: file, ...failure });
      };
      try {
        let design = await designResponse(page, () => page.goto(base.href));
        await ready(page); await shot('first-recorded');
        for (const style of ['warm-reading', 'calm-studio', 'night-desk']) {
          design = await designResponse(page, () => page.getByTestId(`style-${style}`).click());
          await shot(`style-${style}`);
        }
        await page.getByTestId('mode-plan').click(); await shot('plan');
        await page.getByTestId('mode-walk').click(); await shot('walk');
        await page.getByTestId('mode-overview').click();
        design = await designResponse(page, () => page.getByTestId('style-warm-reading').click());
        if (design.fit.passes) throw new Error('Recorded picks have no failing card.');
        await shot('picks-failing');
        design = await swapFailure(page, design); await shot('after-swap');
        const quote = page.waitForResponse(response => new URL(response.url()).pathname === '/api/quote' && response.ok());
        await page.getByTestId('freeze-quote').click(); await quote; await shot('basket');
        await page.getByTestId('judges').click(); await shot('judges-open');
        if (process.env.RECEIPT_ID) {
          await page.goto(new URL(`/?receipt=${encodeURIComponent(process.env.RECEIPT_ID)}`, base).href);
          await ready(page); await page.getByTestId('receipt').waitFor(); await shot('receipt');
        }
      } catch {
        const file = `${viewport.width}-blocked.png`;
        await page.screenshot({ path: resolve(output, file), fullPage: true }).catch(() => {});
        failures.push({ screen: file, control: 'capture', problem: 'Screen capture failed. Check page readiness, test ids, recorded fit and receipt ownership.' });
      }
      finally { await context.close(); }
    }
  } finally { await browser.close(); }
  console.table(failures);
  return failures;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2] || !process.argv[3]) throw new Error('Arguments required.');
    if ((await takeShots(process.argv[2], process.argv[3])).length) process.exitCode = 1;
  } catch { console.error('Usage: node tools/shots.mjs <baseUrl> <outDir>. Screen capture failed.'); process.exitCode = 1; }
}
