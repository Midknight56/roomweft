export const VISIT_ROW_CAP = 300;

type VisitKind = 'page' | 'api';
type VisitVia = 'judges' | 'none';
type VisitTag = { via: VisitVia; src: string };
type Ledger = Pick<D1Database, 'prepare'>;

export function visitKind(req: Request): VisitKind | null {
  const path = new URL(req.url).pathname;
  if (req.method === 'GET' && path === '/') return 'page';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && path.startsWith('/api/')) return 'api';
  return null;
}

function externalSource(referer: string | null): string {
  if (!referer) return 'none';
  try {
    const host = new URL(referer).hostname.toLowerCase();
    if (host === 'devpost.com' || host.endsWith('.devpost.com')) return 'devpost';
    if (host === 'github.com') return 'github';
    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
    return 'other';
  } catch {
    return 'none';
  }
}

export function visitTag(req: Request, kind: VisitKind): VisitTag {
  const referer = req.headers.get('referer');
  if (kind === 'page') {
    let via: VisitVia = 'none';
    try { if (new URL(req.url).searchParams.get('via') === 'judges') via = 'judges'; } catch { /* Request URLs are normally valid. */ }
    return { via, src: externalSource(referer) };
  }
  try {
    if (referer) {
      const source = new URL(referer), target = new URL(req.url);
      if (source.origin === target.origin) return { via: source.searchParams.get('via') === 'judges' ? 'judges' : 'none', src: 'self' };
    }
  } catch { return { via: 'none', src: 'none' }; }
  return { via: 'none', src: externalSource(referer) };
}

export function isBot(req: Request): boolean {
  const agent = req.headers.get('user-agent');
  return !agent || /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|go-http|headless|lighthouse/i.test(agent);
}

export function shouldCount(req: Request): boolean {
  const kind = visitKind(req);
  if (!kind || isBot(req)) return false;
  if (kind === 'api') {
    try {
      const referer = req.headers.get('referer');
      return !!referer && new URL(referer).origin === new URL(req.url).origin;
    } catch { return false; }
  }
  return true;
}

export async function countVisit(req: Request, env: { LEDGER?: D1Database }, app: string): Promise<void> {
  try {
    const kind = visitKind(req);
    if (!kind || isBot(req) || (kind === 'api' && !shouldCount(req)) || !env.LEDGER) return;
    const { via, src } = visitTag(req, kind);
    const day = new Date().toISOString().slice(0, 10);
    await env.LEDGER.prepare(`INSERT INTO visit_counts (day, app, kind, via, src, n) VALUES (?1, ?2, ?3, ?4, ?5, 1)
      ON CONFLICT (day, app, kind, via, src) DO UPDATE SET n = n + 1 WHERE n < ${VISIT_ROW_CAP}`)
      .bind(day, app, kind, via, src).run();
  } catch { /* Visit counting must not affect the response. */ }
}
