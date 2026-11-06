import { afterEach, describe, expect, it, vi } from "vitest";
import { PAYPAL_BASE_URL, PayPalClient } from "../../src/paypal/client";

afterEach(() => vi.useRealTimers());
const oauth = () => new Response(JSON.stringify({ access_token: "test-token", expires_in: 120 }));
const headers = () => new Headers(Object.fromEntries(["auth-algo", "cert-url", "transmission-id", "transmission-sig", "transmission-time"].map(key => [`paypal-${key}`, `test-${key}`])));
const checkedFetch = (handler: typeof fetch): typeof fetch => async (input, init) => {
  if (init?.redirect !== "follow" && init?.redirect !== "manual") {
    throw new TypeError(`Invalid redirect value, must be one of "follow" or "manual" ("${init?.redirect}" won't be implemented since it does not make sense at the edge; use "manual" and check the response status code).`);
  }
  return handler(input, init);
};

describe("PayPal sandbox client", () => {
  it("uses only the sandbox base URL and the specified endpoints and request ids", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = checkedFetch(async (input, init) => {
      calls.push({ url: String(input), init });
      return String(input).endsWith("/token") ? oauth() : new Response('{"id":"test-id"}');
    });
    const client = new PayPalClient({ clientId: "test-client", secret: "test-only", fetch: fetcher });
    expect(PAYPAL_BASE_URL).toBe("https://api-m.sandbox.paypal.com");
    await client.createOrder({ intent: "CAPTURE" }, "request-order");
    await client.captureOrder("a/b", "request-capture");
    await client.getOrder("a/b");
    await client.getCapture("c/d");
    await client.refundCapture("c/d", { amount: { value: "1.00" } }, "request-refund");
    await client.getRefund("r/s");
    expect(calls.map(call => call.url)).toEqual([
      `${PAYPAL_BASE_URL}/v1/oauth2/token`, `${PAYPAL_BASE_URL}/v2/checkout/orders`,
      `${PAYPAL_BASE_URL}/v2/checkout/orders/a%2Fb/capture`, `${PAYPAL_BASE_URL}/v2/checkout/orders/a%2Fb`,
      `${PAYPAL_BASE_URL}/v2/payments/captures/c%2Fd`, `${PAYPAL_BASE_URL}/v2/payments/captures/c%2Fd/refund`, `${PAYPAL_BASE_URL}/v2/payments/refunds/r%2Fs`,
    ]);
    expect(calls.map(call => call.init?.method)).toEqual(["POST", "POST", "POST", "GET", "GET", "POST", "GET"]);
    const tokenHeaders = new Headers(calls[0].init?.headers);
    expect(tokenHeaders.get("Authorization")).toBe(`Basic ${btoa("test-client:test-only")}`);
    expect(calls[0].init?.body).toBe("grant_type=client_credentials");
    expect(new Headers(calls[1].init?.headers).get("PayPal-Request-Id")).toBe("request-order");
    expect(new Headers(calls[2].init?.headers).get("PayPal-Request-Id")).toBe("request-capture");
    expect(new Headers(calls[5].init?.headers).get("PayPal-Request-Id")).toBe("request-refund");
    expect(new Headers(calls[1].init?.headers).get("Authorization")).toBe("Bearer test-token");
    expect(new Headers(calls[2].init?.headers).get("Prefer")).toBe("return=representation");
    expect(calls.every(call => call.init?.redirect === "manual")).toBe(true);
  });

  it("calls the platform fetch without binding the client as this", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = function (this: unknown, input: RequestInfo | URL): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      const url = String(input);
      calls.push(url);
      return Promise.resolve(url.endsWith("/token") ? oauth() : new Response('{"id":"test-order"}'));
    };
    try {
      const client = new PayPalClient({ clientId: "test", secret: "test" });
      expect(await client.token()).toMatchObject({ ok: true, body: { access_token: "test-token" } });
      expect(await client.createOrder({}, "request")).toMatchObject({ ok: true, body: { id: "test-order" } });
      expect(calls).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it("shares a token request and refreshes exactly 60 seconds before expiry", async () => {
    let now = 1000;
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return oauth(); };
    const client = new PayPalClient({ clientId: "test", secret: "test", fetch: fetcher, clock: () => now });
    await Promise.all([client.token(), client.token()]);
    expect(calls).toBe(1);
    now += 59_999;
    await client.token();
    expect(calls).toBe(1);
    now++;
    await client.token();
    expect(calls).toBe(2);
  });

  it("returns typed HTTP errors and does not call orders after a token failure", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{"name":"INVALID_CLIENT"}', { status: 401 }));
    const client = new PayPalClient({ clientId: "test", secret: "test", fetch: fetcher });
    expect(await client.createOrder({}, "stable")).toEqual({ ok: false, kind: "http", status: 401, body: { name: "INVALID_CLIENT" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves endpoint HTTP status and error details", async () => {
    const fetcher: typeof fetch = async input => String(input).endsWith("/token") ? oauth()
      : new Response('{"name":"UNPROCESSABLE_ENTITY","details":[{"issue":"INSTRUMENT_DECLINED"}]}', { status: 422 });
    const client = new PayPalClient({ clientId: "test", secret: "test", fetch: fetcher });
    expect(await client.captureOrder("o", "r")).toEqual({ ok: false, kind: "http", status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] } });
  });

  it("returns a redirect refusal as a known HTTP failure", async () => {
    const fetcher = checkedFetch(async input => String(input).endsWith("/token") ? oauth() : new Response("", { status: 302 }));
    const client = new PayPalClient({ clientId: "test", secret: "test", fetch: fetcher });
    expect(await client.createOrder({}, "stable")).toEqual({ ok: false, kind: "http", status: 302, body: {} });
  });

  it("returns lost on a network failure", async () => {
    const client = new PayPalClient({ clientId: "test", secret: "test", fetch: async () => { throw new Error("Test network failure."); } });
    expect(await client.token()).toEqual({ ok: false, kind: "lost" });
  });
  it("rejects an incomplete token response and does not cache it", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{"expires_in":120}'));
    const client = new PayPalClient({ clientId: "test", secret: "test", fetch: fetcher });
    expect(await client.token()).toEqual({ ok: false, kind: "lost" });
    expect(await client.token()).toEqual({ ok: false, kind: "lost" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps a non JSON HTTP failure typed", async () => {
    const client = new PayPalClient({ clientId: "test", secret: "test", fetch: async () => new Response("unavailable", { status: 503 }) });
    expect(await client.token()).toEqual({ ok: false, kind: "http", status: 503, body: {} });
  });

  it.each(["token", "resource", "body"])("times out a stalled %s in 10 seconds and aborts it", async phase => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      if (phase !== "token" && String(input).endsWith("/token")) return oauth();
      signal = init?.signal;
      if (phase === "body") return new Response(new ReadableStream({ start() {} }));
      return new Promise(() => {});
    };
    const client = new PayPalClient({ clientId: "test", secret: "test", fetch: fetcher });
    if (phase !== "token") await client.token();
    const pending = phase === "token" ? client.token() : client.getOrder("test");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ ok: false, kind: "lost" });
    expect(signal?.aborted).toBe(true);
  });

  it("embeds webhook body text exactly, including spacing and escaped strings", async () => {
    let submitted = "";
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/token")) return oauth();
      expect(String(input)).toBe(`${PAYPAL_BASE_URL}/v1/notifications/verify-webhook-signature`);
      submitted = String(init?.body);
      return new Response('{"verification_status":"SUCCESS"}');
    };
    const raw = '{ "id" : "event",\n "resource": {"text":"a\\nb"} }\n';
    const client = new PayPalClient({ clientId: "test", secret: "test", fetch: fetcher });
    expect(await client.verifyWebhook(headers(), raw, "webhook-test")).toBe(true);
    expect(submitted.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(submitted)).toEqual({ auth_algo: "test-auth-algo", cert_url: "test-cert-url", transmission_id: "test-transmission-id", transmission_sig: "test-transmission-sig", transmission_time: "test-transmission-time", webhook_id: "webhook-test", webhook_event: JSON.parse(raw) });
  });

  it.each(["FAILURE", "", "success"])("rejects webhook verification status %s", async status => {
    const client = new PayPalClient({ clientId: "test", secret: "test", fetch: async input => String(input).endsWith("/token") ? oauth() : new Response(JSON.stringify({ verification_status: status })) });
    expect(await client.verifyWebhook(headers(), "{}", "test")).toBe(false);
  });
  it("rejects missing signature headers without a network call", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new PayPalClient({ clientId: "test", secret: "test", fetch: fetcher });
    expect(await client.verifyWebhook(new Headers(), "{}", "test")).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
