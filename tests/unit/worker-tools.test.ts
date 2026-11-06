import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWebhook, WEBHOOK_URL, EVENT_TYPES } from '../../tools/register-webhook.mjs';
import { approveBuyer, sandboxApproveUrl, BuyerChallenge, hasChallenge, type BuyerPage } from '../../tools/buyer.mjs';
import { measureControls } from '../../tools/shots.mjs';
import { visitorCookies } from '../../tools/browser-helpers.mjs';
afterEach(() => { vi.unstubAllGlobals(); });
describe('worker support tools', () => {
  it('reuses receipt ownership only with an explicitly supplied valid visitor', () => {
    expect(visitorCookies(undefined)).toEqual([]);
    expect(() => visitorCookies('https://room.test', 'bad')).toThrow('visitor');
    expect(() => visitorCookies(undefined, 'a'.repeat(32))).toThrow();
    expect(visitorCookies('https://room.test/return?token=order', 'a'.repeat(32))).toEqual([
      { name: 'rw_vid', value: 'a'.repeat(32), url: 'https://room.test/', httpOnly: true, secure: true, sameSite: 'Lax' },
    ]);
  });
  it('reuses a webhook with the exact URL without creating another', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'test-only' }))
      .mockResolvedValueOnce(Response.json({ webhooks: [{ id: 'existing', url: WEBHOOK_URL }] }));
    expect(await registerWebhook({ clientId: 'test-client', secret: 'test-only', fetcher })).toBe('existing'); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('https://api-m.sandbox.paypal.com/'))).toBe(true);
  });
  it('registers only the five events when the URL is missing', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'test-only' }))
      .mockResolvedValueOnce(Response.json({ webhooks: [] })).mockResolvedValueOnce(Response.json({ id: 'new' }));
    expect(await registerWebhook({ clientId: 'test-client', secret: 'test-only', fetcher })).toBe('new');
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ url: WEBHOOK_URL, event_types: EVENT_TYPES.map(name => ({ name })) }); expect(EVENT_TYPES).toHaveLength(5);
  });
  it('refuses missing credentials, failed authentication, invalid lists and failed creation', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(registerWebhook({ fetcher })).rejects.toThrow('credentials'); expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(registerWebhook({ clientId: 'test', secret: 'test', fetcher })).rejects.toThrow('401');
    fetcher.mockResolvedValueOnce(Response.json({ access_token: 'test' })).mockResolvedValueOnce(Response.json({}));
    await expect(registerWebhook({ clientId: 'test', secret: 'test', fetcher })).rejects.toThrow('no list');
    fetcher.mockResolvedValueOnce(Response.json({ access_token: 'test' })).mockResolvedValueOnce(Response.json({ webhooks: [] })).mockResolvedValueOnce(new Response(null, { status: 422 }));
    await expect(registerWebhook({ clientId: 'test', secret: 'test', fetcher })).rejects.toThrow('422');
  });
  it('limits buyer approval to the sandbox host', () => {
    expect(sandboxApproveUrl('https://www.sandbox.paypal.com/checkoutnow?token=TEST')).toContain('token=TEST');
    for (const url of ['http://www.sandbox.paypal.com/', 'https://evil.test/', 'https://user:pass@www.sandbox.paypal.com/']) expect(() => sandboxApproveUrl(url)).toThrow();
  });
  function buyer(challenge = false, text = '', login = false, challengeVisible = true) {
    let current = 'https://www.sandbox.paypal.com/checkoutnow';
    const clicked: string[] = [], filled: string[] = [];
    let phase = login ? 'email' : 'pay';
    const page: BuyerPage = {
      goto: async url => { current = url; }, url: () => current,
      waitForLoadState: async () => {},
      waitForURL: async predicate => { if (!predicate(new URL(current))) throw new Error('URL did not return'); },
      locator: selector => {
        const locator = {
          count: async () => challenge ? 1 : 0, innerText: async () => text,
          boundingBox: async () => challenge ? { x: 0, y: 0, width: 40, height: 40 } : null,
          all: async () => [locator], first: () => locator,
          isVisible: async () => selector === '#email' ? phase === 'email' : selector === '#password' ? phase === 'password' : selector.includes('captcha') || selector.includes('challenge') ? challengeVisible : true,
          waitFor: async (options: { state: 'visible' | 'hidden'; timeout?: number }) => { const visible = selector === '#email' ? phase === 'email' : selector === '#password' ? phase === 'password' : selector.includes('aria-busy') ? false : selector.includes('#payment-submit-btn') ? phase === 'pay' : false; if ((options.state === 'visible') !== visible) throw new Error('not visible'); },
          isEnabled: async () => true,
          fill: async (_value: string) => { filled.push(selector); },
          click: async () => { clicked.push(selector); if (selector.includes('#btnNext')) phase = 'password'; else if (selector.includes('#btnLogin')) phase = 'pay'; else current = 'https://room.test/?receipt=quote'; },
        };
        return locator;
      },
    };
    return { page, clicked, filled };
  }
  it('logs in then pays and returns only the final URL', async () => {
    const { page, clicked, filled } = buyer(false, '', true);
    expect(await approveBuyer(page, 'https://www.sandbox.paypal.com/checkoutnow', { email: 'test@example.test', password: 'test-only' })).toBe('https://room.test/?receipt=quote');
    expect(clicked).toHaveLength(3); expect(filled).toHaveLength(2); expect(clicked[2]).toContain('#payment-submit-btn');
  });
  it('stops on a challenge before entering credentials or paying', async () => {
    for (const sample of [buyer(true, '', true), buyer(false, 'Verify you are human', true)]) {
      await expect(approveBuyer(sample.page, 'https://www.sandbox.paypal.com/', { email: 'test', password: 'test-only' })).rejects.toBeInstanceOf(BuyerChallenge);
      expect(sample.clicked).toHaveLength(2); expect(sample.filled).toHaveLength(2);
    }
  });
  it('ignores a hidden captcha frame but stops for a visible one', async () => {
    const hidden = buyer(true, '', true, false);
    expect(await hasChallenge(hidden.page)).toBe(false);
    const visible = buyer(true, '', true);
    expect(await hasChallenge(visible.page)).toBe(true);
  });
  it('refuses missing buyer credentials and reports a timeout at step 3', async () => {
    const { page } = buyer();
    await expect(approveBuyer(page, 'https://www.sandbox.paypal.com/')).rejects.toThrow('credentials');
    await expect(approveBuyer(page, 'https://www.sandbox.paypal.com/', { email: 'test', password: 'test' })).rejects.toThrow('step 3');
  });
  function measurement({ left = 16, top = 16, right = 150, bottom = 56, textLeft = 24, textRight = 142, scrollWidth = 390 } = {}) {
    const text = { textContent: 'Pay' }; let walked = false;
    const control = { getClientRects: () => [{}], getBoundingClientRect: () => ({ left, right, top, bottom }),
      getAttribute: () => 'pay', textContent: 'Pay', tagName: 'BUTTON', matches: () => true };
    vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844); vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4 });
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }));
    vi.stubGlobal('document', { querySelectorAll: () => [control], documentElement: { scrollWidth }, body: { scrollWidth },
      createTreeWalker: () => ({ nextNode: () => walked ? null : (walked = true, text) }),
      createRange: () => ({ selectNodeContents: () => {}, getClientRects: () => [{ left: textLeft, right: textRight, top: 24, bottom: 48 }] }),
    });
  }
  it('accepts controls with sufficient margins and button padding', () => { measurement(); expect(measureControls()).toEqual([]); });
  it('finds clipped controls, tight button padding and horizontal scrolling', () => {
    measurement({ left: 2, top: 2, right: 389, bottom: 850, textLeft: 4, textRight: 388, scrollWidth: 400 });
    const failures = measureControls();
    expect(failures.some(f => f.problem.includes('sides'))).toBe(true); expect(failures.some(f => f.problem.includes('edges'))).toBe(true);
    expect(failures.some(f => f.problem.includes('8 px'))).toBe(true); expect(failures.some(f => f.problem.includes('Horizontal'))).toBe(true);
  });
});
