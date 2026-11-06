import { pathToFileURL } from 'node:url';
export const WEBHOOK_URL = 'https://roomweft.midknight-labs.workers.dev/webhooks/paypal';
export const EVENT_TYPES = ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.REFUNDED'];
const base = 'https://api-m.sandbox.paypal.com';
export async function registerWebhook({ clientId, secret, fetcher = fetch }) {
  if (!clientId || !secret) throw new Error('Sandbox credentials are required.');
  const tokenResponse = await fetcher(`${base}/v1/oauth2/token`, { method: 'POST', headers: {
    authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded',
  }, body: 'grant_type=client_credentials' });
  if (!tokenResponse.ok) throw new Error(`Sandbox authentication failed (${tokenResponse.status}).`);
  const token = await tokenResponse.json();
  if (typeof token.access_token !== 'string') throw new Error('Sandbox authentication failed.');
  const headers = { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' };
  const listed = await fetcher(`${base}/v1/notifications/webhooks`, { headers });
  if (!listed.ok) throw new Error(`Webhook lookup failed (${listed.status}).`);
  const list = await listed.json();
  if (!Array.isArray(list.webhooks)) throw new Error('Webhook lookup returned no list.');
  const existing = list.webhooks.find(hook => hook.url === WEBHOOK_URL);
  if (existing) {
    if (typeof existing.id !== 'string') throw new Error('Webhook lookup returned no id.');
    return existing.id;
  }
  const created = await fetcher(`${base}/v1/notifications/webhooks`, { method: 'POST', headers,
    body: JSON.stringify({ url: WEBHOOK_URL, event_types: EVENT_TYPES.map(name => ({ name })) }),
  });
  if (!created.ok) throw new Error(`Webhook creation failed (${created.status}).`);
  const hook = await created.json();
  if (typeof hook.id !== 'string') throw new Error('Webhook creation returned no id.');
  return hook.id;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(await registerWebhook({ clientId: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_SECRET })); }
  catch { console.error('Sandbox webhook registration failed. Check credentials and connectivity.'); process.exitCode = 1; }
}
