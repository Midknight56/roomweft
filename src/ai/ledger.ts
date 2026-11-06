// RoomWeft's share: 1,200 neurons a day (12% of the free 10,000). Every hackathon app writes to this ledger and the
// whole account stops at 9,500, under the free 10,000 a day; the account is on the Workers Free plan, which has no
// paid overage. A call is capped at 3,000 input and 400 output tokens: 3,000 x 4,625 / 1e6 + 400 x 30,475 / 1e6 =
// 26.1 neurons, so 45 held before each call covers it. 1,200 / 45 = 26 live designs a day at most. Total paid cost: $0.
export const APP = 'roomweft';
export const DAILY_NEURONS = 1200;
export const ACCOUNT_NEURONS = 9500;
export const RESERVE = 45;
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
