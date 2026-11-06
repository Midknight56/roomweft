import { launchBrowser, visitorCookies } from './browser-helpers.mjs';
import { pathToFileURL } from 'node:url';
export class BuyerChallenge extends Error {}
export function sandboxApproveUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'www.sandbox.paypal.com' || url.username || url.password) throw new Error('Use a sandbox approval URL.');
  return url.href;
}
export async function hasChallenge(page) {
  const elements = await page.locator('iframe[src*="captcha"], iframe[src*="challenge"], #captcha, #recaptcha, [data-testid*="captcha"]').all();
  for (const element of elements) {
    const bounds = await element.boundingBox();
    if (await element.isVisible() && bounds && bounds.width > 30 && bounds.height > 30) return true;
  }
  return /security challenge|security check|verify you are human|confirm you.re not a robot|solve the puzzle|unusual activity/i.test(await page.locator('body').innerText());
}
export async function approveBuyer(page, approveUrl, { email, password } = {}) {
  sandboxApproveUrl(approveUrl);
  if (!email || !password) throw new Error('Sandbox buyer credentials are required.');
  await page.goto(approveUrl, { waitUntil: 'domcontentloaded' });
  const emailInput = page.locator('#email');
  let emailVisible = true;
  try { await emailInput.waitFor({ state: 'visible', timeout: 15000 }); }
  catch { emailVisible = false; }
  if (emailVisible) {
    await emailInput.fill(email);
    const next = page.locator('#btnNext');
    if (await next.isVisible().catch(() => false)) await next.click();
  }
  const passwordInput = page.locator('#password');
  try { await passwordInput.waitFor({ state: 'visible', timeout: 20000 }); }
  catch { throw new Error('Sandbox approval timed out at step 3 (password page).'); }
  await passwordInput.fill(password);
  await page.locator('#btnLogin').click();
  await page.waitForLoadState('domcontentloaded');
  const afterLogin = new URL(page.url());
  if (/(^|\.)paypal\.com$/i.test(afterLogin.hostname) && afterLogin.hostname !== 'www.sandbox.paypal.com') throw new Error('Approval left the sandbox.');
  if (await hasChallenge(page)) throw new BuyerChallenge('A person must complete the security challenge.');
  const submit = page.locator('#payment-submit-btn, [data-testid="submit-button-initial"], button:has-text("Complete Purchase"), button:has-text("Pay Now"), button:has-text("Continue")').first();
  try { await submit.waitFor({ state: 'visible', timeout: 30000 }); }
  catch { throw new Error('Sandbox approval timed out at step 5 (payment button).'); }
  try { await page.locator('[aria-busy="true"]').waitFor({ state: 'hidden', timeout: 15000 }); }
  catch { throw new Error('Sandbox approval timed out at step 5 (spinner).'); }
  await submit.click();
  try { await page.waitForURL(url => !/(^|\.)paypal\.com$/i.test(new URL(url).hostname), { timeout: 45000 }); }
  catch { throw new Error('Sandbox approval timed out at step 6 (return URL).'); }
  const result = new URL(page.url());
  if (/(^|\.)paypal\.com$/i.test(result.hostname)) throw new Error('Sandbox approval timed out at step 6 (return URL).');
  return result.href;
}if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let browser;
  try {
    sandboxApproveUrl(process.argv[2]);
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.context().addCookies(visitorCookies(process.env.ROOMWEFT_ORIGIN, process.env.ROOMWEFT_VISITOR_ID));
    console.log(await approveBuyer(page, process.argv[2], { email: process.env.PAYPAL_SANDBOX_BUYER_EMAIL, password: process.env.PAYPAL_SANDBOX_BUYER_PASSWORD }));
  } catch (error) {
    console.error(error instanceof BuyerChallenge ? 'A person must complete the sandbox security challenge.' : 'Sandbox approval failed. Check the URL, credentials and connectivity.');
    process.exitCode = error instanceof BuyerChallenge ? 3 : 1;
  } finally { await browser?.close(); }
}
