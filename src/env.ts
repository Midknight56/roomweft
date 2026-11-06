export interface Env {
  ASSETS: Pick<Fetcher, "fetch">;
  AI: Ai;
  DB: D1Database;
  LEDGER: D1Database;
  PUBLIC_ORIGIN: string;
  CHANNEL3_API_KEY?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  JUDGE_BUYER_EMAIL?: string;
  JUDGE_BUYER_PASSWORD?: string;
}
