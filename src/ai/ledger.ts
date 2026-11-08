// Source read 2026-11-06: https://developers.cloudflare.com/workers-ai/platform/pricing/
// Granite: 1542 neurons per M input tokens, 10158 per M output tokens. $0.011 per 1,000 Neurons;
// 10,000 Neurons per day at no charge. The 10,500 character prompt cap is about 3,000 input tokens.
// 3,000 x 1542 / 1e6 + 400 x 10158 / 1e6 = 4.626 + 4.0632 = 8.6892 neurons, below the 10 neuron hold.
// Brief: 600 x 1542 / 1e6 + 200 x 10158 / 1e6 = 0.9252 + 2.0316 = 2.9568 neurons, below the 10 neuron hold.
// Per visitor: 3 live designs x 2 calls x 10 neurons held = 60 neurons at most, still $0 within the shared cap.
// The app's 1,200/day covers at least 138 worst case call costs; the hold can stop calls earlier near the cap.
// Every hackathon app shares this ledger. The 9,500 account cap is under the free 10,000, so calls cost $0.
export const APP = 'roomweft';
export const DAILY_NEURONS = 1200;
export const ACCOUNT_NEURONS = 9500;
export const RESERVE = 10;
export class NeuronLedger {
  constructor(private db: D1Database, private now: () => number = Date.now) {}
  async reserve(): Promise<number | null> {
    try {
      const day = new Date(this.now()).toISOString().slice(0,10);
      const row = await this.db.prepare(`INSERT INTO ai_calls (app,day,neurons) SELECT ?,?,?
        WHERE (SELECT COALESCE(SUM(neurons),0) FROM ai_calls WHERE app=? AND day=?) + ? <= ?
        AND (SELECT COALESCE(SUM(neurons),0) FROM ai_calls WHERE day=?) + ? <= ? RETURNING id`)
        .bind(APP, day, RESERVE, APP, day, RESERVE, DAILY_NEURONS, day, RESERVE, ACCOUNT_NEURONS).first<{id:number}>();
      return row?.id ?? null;
    } catch { return null; }
  }
  async settle(id: number, neurons: number): Promise<void> {
    if (!Number.isFinite(neurons) || neurons < 0) return;
    try { await this.db.prepare('UPDATE ai_calls SET neurons=? WHERE id=? AND app=?').bind(neurons, id, APP).run(); } catch { /* Keep the hold on an uncertain write. */ }
  }
  async remaining(): Promise<number> {
    try {
      const day = new Date(this.now()).toISOString().slice(0,10);
      const row = await this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN app=? THEN neurons ELSE 0 END),0) AS app,
        COALESCE(SUM(neurons),0) AS account FROM ai_calls WHERE day=?`).bind(APP, day).first<{app:number;account:number}>();
      return Math.max(0, Math.min(DAILY_NEURONS - (row?.app ?? 0), ACCOUNT_NEURONS - (row?.account ?? 0)));
    } catch { return 0; }
  }
}
