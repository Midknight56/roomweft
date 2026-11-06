export const PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com";

export interface Money { currency_code: string; value: string }
export interface PayPalLink { rel: string; href: string }
export interface PayPalResource {
  id?: string;
  status?: string;
  amount?: Money;
  invoice_id?: string;
  custom_id?: string;
  links?: PayPalLink[];
  refunds?: PayPalResource[];
  purchase_units?: { custom_id?: string; payments?: { captures?: PayPalResource[]; refunds?: PayPalResource[] } }[];
  supplementary_data?: { related_ids?: { capture_id?: string; order_id?: string } };
}
export interface PayPalError {
  name?: string;
  details?: { issue?: string }[];
  links?: PayPalLink[];
}
export type PayPalResult<T = PayPalResource> =
  | { ok: true; status: number; body: T }
  | { ok: false; kind: "http"; status: number; body: PayPalError }
  | { ok: false; kind: "lost" };
export interface OAuthToken { access_token: string; expires_in: number }
export interface PayPalGateway {
  createOrder(body: unknown, requestId: string): Promise<PayPalResult>;
  captureOrder(orderId: string, requestId: string): Promise<PayPalResult>;
  getOrder(orderId: string): Promise<PayPalResult>;
  getCapture(id: string): Promise<PayPalResult>;
  refundCapture(captureId: string, body: unknown, requestId: string): Promise<PayPalResult>;
  getRefund(id: string): Promise<PayPalResult>;
  verifyWebhook(headers: Headers, rawBody: string, webhookId: string): Promise<boolean>;
}
export interface PayPalClientOptions {
  clientId: string;
  secret: string;
  fetch?: typeof fetch;
  clock?: () => number;
}

export class PayPalClient implements PayPalGateway {
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private cached?: { body: OAuthToken; until: number };
  private tokenRequest?: Promise<PayPalResult<OAuthToken>>;

  constructor(private readonly options: PayPalClientOptions) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? Date.now;
  }

  private async request<T>(path: string, init: RequestInit): Promise<PayPalResult<T>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PayPalResult<T>>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ ok: false, kind: "lost" }); }, 10_000);
    });
    const operation = async (): Promise<PayPalResult<T>> => {
      try {
        const response = await this.fetcher(`${PAYPAL_BASE_URL}${path}`, { ...init, redirect: "manual", signal: controller.signal });
        const raw = await response.text();
        let body: unknown = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { /* An HTTP error need not have a JSON body. */ }
        if (!response.ok) return { ok: false, kind: "http", status: response.status, body: body as PayPalError };
        return { ok: true, status: response.status, body: body as T };
      } catch { return { ok: false, kind: "lost" }; }
    };
    try { return await Promise.race([operation(), timeout]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async token(): Promise<PayPalResult<OAuthToken>> {
    if (this.cached && this.clock() < this.cached.until) return { ok: true, status: 200, body: this.cached.body };
    if (this.tokenRequest) return this.tokenRequest;
    const started = this.clock();
    this.tokenRequest = this.request<OAuthToken>("/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${this.options.clientId}:${this.options.secret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    try {
      const result = await this.tokenRequest;
      if (result.ok) {
        if (!result.body?.access_token || !Number.isFinite(result.body.expires_in)) return { ok: false, kind: "lost" };
        this.cached = { body: result.body, until: started + Math.max(0, result.body.expires_in - 60) * 1000 };
      }
      return result;
    } finally { this.tokenRequest = undefined; }
  }

  private async authorized<T = PayPalResource>(path: string, method: string, body?: string, requestId?: string): Promise<PayPalResult<T>> {
    const token = await this.token();
    if (!token.ok) return token;
    const headers: Record<string, string> = { Authorization: `Bearer ${token.body.access_token}`, "Content-Type": "application/json" };
    if (method === "POST") headers.Prefer = "return=representation";
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    return this.request<T>(path, { method, headers, body });
  }

  createOrder(body: unknown, requestId: string): Promise<PayPalResult> {
    return this.authorized("/v2/checkout/orders", "POST", JSON.stringify(body), requestId);
  }
  captureOrder(orderId: string, requestId: string): Promise<PayPalResult> {
    return this.authorized(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, "POST", "{}", requestId);
  }
  getOrder(orderId: string): Promise<PayPalResult> {
    return this.authorized(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, "GET");
  }
  getCapture(id: string): Promise<PayPalResult> {
    return this.authorized(`/v2/payments/captures/${encodeURIComponent(id)}`, "GET");
  }
  refundCapture(captureId: string, body: unknown, requestId: string): Promise<PayPalResult> {
    return this.authorized(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, "POST", JSON.stringify(body), requestId);
  }
  getRefund(id: string): Promise<PayPalResult> {
    return this.authorized(`/v2/payments/refunds/${encodeURIComponent(id)}`, "GET");
  }
  async verifyWebhook(headers: Headers, rawBody: string, webhookId: string): Promise<boolean> {
    const fields: Record<string, string> = {};
    for (const field of ["auth_algo", "cert_url", "transmission_id", "transmission_sig", "transmission_time"]) {
      const value = headers.get(`paypal-${field.replaceAll("_", "-")}`);
      if (!value) return false;
      fields[field] = value;
    }
    const prefix = JSON.stringify({ ...fields, webhook_id: webhookId });
    const body = `${prefix.slice(0, -1)},"webhook_event":${rawBody}}`;
    const result = await this.authorized<{ verification_status?: string }>("/v1/notifications/verify-webhook-signature", "POST", body);
    return result.ok && result.body?.verification_status === "SUCCESS";
  }
}
