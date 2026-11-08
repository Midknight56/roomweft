import type { Candidate, SourceRecord } from '../shared/api-types';
import { dimsFromOffer } from '../shared/fit';
import type { SlotId } from '../shared/room';

export function withSlotDims<T extends Candidate>(candidate: T, slot: SlotId): T {
  const raw = candidate.dimsRaw;
  if (!raw) return candidate;
  const hasMeasurements = Object.values(raw).some(value => {
    const measurement = object(value);
    return typeof measurement.number === 'number';
  });
  return { ...candidate, dims: dimsFromOffer(raw, slot === 'rug' ? 'rug' : undefined), hasMeasurements };
}

export type ProductCandidate = Candidate & { dimsRaw: Record<string, unknown> | null };
export type SearchResult = { ok: true; candidates: ProductCandidate[]; source: SourceRecord }
  | { ok: false; reason: 'off' | 'capped' | 'spent' | 'error' };
export const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown): string[] => array(value).filter((v): v is string => typeof v === 'string');
function https(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password) return url.href; } catch { /* Invalid link. */ }
}
export function mapProduct(raw: unknown, kind?: string): ProductCandidate | null {
  const p = object(raw);
  if (typeof p.id !== 'string' || typeof p.title !== 'string') return null;
  const offers = array(p.offers).map(object).filter(o => {
    const price = object(o.price);
    return o.availability === 'InStock' && o.condition === 'new' && price.currency === 'USD'
      && typeof price.price === 'number' && Number.isSafeInteger(Math.round(price.price * 100))
      && price.price >= 0 && https(o.url);
  }).sort((a, b) => Number(object(a.price).price) - Number(object(b.price).price));
  const offer = offers[0];
  if (!offer) return null;
  const image = array(p.images).map(object).sort((a,b) => Number(!!b.is_main_image) - Number(!!a.is_main_image))
    .map(i => https(i.cleaned_url) ?? https(i.url)).find(Boolean);
  const brand = object(array(p.brands)[0]).name;
  const category = object(p.category).slug;
  return {
    id: p.id, title: p.title, ...(typeof brand === 'string' ? { brand } : {}),
    priceCents: Math.round(Number(object(offer.price).price) * 100), currency: 'USD', url: https(offer.url)!,
    domain: typeof offer.domain === 'string' ? offer.domain : new URL(String(offer.url)).hostname,
    ...(image ? { image } : {}), materials: strings(p.materials),
    colors: array(p.colors).map(object).sort((a,b) => Number(b.percentage ?? 0) - Number(a.percentage ?? 0))
      .map(c => c.hex).filter((v): v is string => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v)).slice(0,3),
    ...(typeof category === 'string' ? { category } : {}), dims: dimsFromOffer(offer.dimensions, kind),
    dimsRaw: typeof offer.dimensions === 'object' && offer.dimensions !== null ? object(offer.dimensions) : null,
  };
}
export function mapProducts(response: unknown): ProductCandidate[] {
  return array(object(response).products).map(raw => mapProduct(raw)).filter((p): p is ProductCandidate => p !== null);
}
export async function takeCounter(db: D1Database, key: string, cap: number, now: number): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0,10);
  const result = await db.prepare(`INSERT INTO counters (key, day, n) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET day = excluded.day,
    n = CASE WHEN counters.day = excluded.day THEN counters.n + 1 ELSE 1 END
    WHERE counters.day <> excluded.day OR counters.n < ?`).bind(key, day, cap).run();
  return result.meta.changes === 1;
}
export interface ChannelOptions { db: D1Database; apiKey?: string; fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> }
export class Channel3 {
  private now: () => number;
  constructor(private options: ChannelOptions) { this.now = options.now ?? Date.now; }
  search(query: string, maxPrice: number): Promise<SearchResult> {
    const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
    return this.request(`search:${JSON.stringify([normalized, maxPrice])}`, normalized, maxPrice, '/search',
      { query: normalized, limit: 8, filters: { price: { max_price: maxPrice } } }, 7 * 86400000);
  }
  product(id: string): Promise<SearchResult> {
    return this.request(`product:${id}`, `product:${id}`, 0, `/products/${encodeURIComponent(id)}`, undefined, 6 * 3600000);
  }
  private async request(key: string, query: string, maxPrice: number, path: string, body: unknown, ttl: number): Promise<SearchResult> {
    const { db, apiKey } = this.options;
    try {
      const cached = await db.prepare('SELECT body, retrieved_at FROM product_searches WHERE key = ? AND expires_at > ?')
        .bind(key, this.now()).first<{ body: string; retrieved_at: number }>();
      if (cached) return this.success(JSON.parse(cached.body) as ProductCandidate[], query, maxPrice, cached.retrieved_at, true);
      if (!apiKey) return { ok: false, reason: 'off' };
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!await takeCounter(db, 'channel3', 300, this.now())) return { ok: false, reason: 'capped' };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        let response: Response;
        let raw: unknown;
        try {
          response = await (this.options.fetch ?? fetch)(`https://api.trychannel3.com/v1${path}`, {
            method: body === undefined ? 'GET' : 'POST', headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
          });
          if (response.ok) raw = await response.json();
        } finally { clearTimeout(timeout); }
        if (response.status === 402) return { ok: false, reason: 'spent' };
        if (response.status === 429 && attempt === 0) {
          const seconds = Number(response.headers.get('Retry-After') ?? 0);
          await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(Math.min(5, Math.max(0, Number.isFinite(seconds) ? seconds : 0)) * 1000);
          continue;
        }
        if (response.status === 404 && body === undefined) raw = { products: [] };
        else if (!response.ok) return { ok: false, reason: 'error' };
        const candidates = body === undefined && response.status !== 404
          ? [mapProduct(object(raw).product ?? raw)].filter((p): p is ProductCandidate => p !== null) : mapProducts(raw);
        const at = this.now();
        await db.prepare(`INSERT INTO product_searches (key,query,max_price,result_ids,body,retrieved_at,expires_at)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body, result_ids=excluded.result_ids,
          retrieved_at=excluded.retrieved_at, expires_at=excluded.expires_at`)
          .bind(key, query, maxPrice, JSON.stringify(candidates.map(p => p.id)), JSON.stringify(candidates), at, at + ttl).run();
        return this.success(candidates, query, maxPrice, at, false);
      }
    } catch { return { ok: false, reason: 'error' }; }
    return { ok: false, reason: 'error' };
  }
  private success(candidates: ProductCandidate[], query: string, maxPrice: number, retrievedAt: number, cached: boolean): SearchResult {
    return { ok: true, candidates, source: { query, maxPrice, resultIds: candidates.map(p => p.id), retrievedAt, cached, origin: 'live' } };
  }
}
