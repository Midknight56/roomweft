import { describe, expect, it, vi } from 'vitest';
import { countVisit, isBot, shouldCount, visitKind, visitTag } from '../../src/visit-count';

const req = (url: string, method = 'GET', headers: Record<string, string> = {}) => new Request(url, { method, headers: { 'user-agent': 'Mozilla/5.0', ...headers } });

describe('visit counts', () => {
  it('classifies home pages and API actions', () => {
    expect(visitKind(req('https://room.test/'))).toBe('page');
    expect(visitKind(req('https://room.test/', 'HEAD'))).toBeNull();
    expect(visitKind(req('https://room.test/api/design', 'POST'))).toBe('api');
    expect(visitKind(req('https://room.test/api/design'))).toBeNull();
    expect(visitKind(req('https://room.test/about'))).toBeNull();
  });

  it('tags judge pages and recognized referrers', () => {
    expect(visitTag(req('https://room.test/?via=judges'), 'page')).toEqual({ via: 'judges', src: 'none' });
    expect(visitTag(req('https://room.test/', 'GET', { referer: 'https://www.devpost.com/project' }), 'page').src).toBe('devpost');
    expect(visitTag(req('https://room.test/', 'GET', { referer: 'https://github.com/example' }), 'page').src).toBe('github');
    expect(visitTag(req('https://room.test/', 'GET', { referer: 'https://youtu.be/abc' }), 'page').src).toBe('youtube');
    expect(visitTag(req('https://room.test/'), 'page').src).toBe('none');
    expect(visitTag(req('https://room.test/', 'GET', { referer: 'not a URL' }), 'page').src).toBe('none');
  });

  it('tags same origin API requests from the judges page', () => {
    expect(visitTag(req('https://room.test/api/design', 'POST', { referer: 'https://room.test/?via=judges' }), 'api'))
      .toEqual({ via: 'judges', src: 'self' });
    expect(visitTag(req('https://room.test/api/design', 'POST', { referer: 'https://devpost.com/project' }), 'api'))
      .toEqual({ via: 'none', src: 'devpost' });
  });

  it('filters missing and known bot user agents', () => {
    expect(isBot(new Request('https://room.test/'))).toBe(true);
    expect(isBot(req('https://room.test/', 'GET', { 'user-agent': 'Googlebot' }))).toBe(true);
    expect(isBot(req('https://room.test/', 'GET', { 'user-agent': 'Mozilla/5.0' }))).toBe(false);
  });

  it('only counts same origin API actions and browser page visits', () => {
    expect(shouldCount(req('https://room.test/api/design', 'POST', { referer: 'https://other.test/' }))).toBe(false);
    expect(shouldCount(req('https://room.test/api/design', 'POST'))).toBe(false);
    expect(shouldCount(req('https://room.test/api/design', 'POST', { referer: 'https://room.test/?via=judges' }))).toBe(true);
    expect(shouldCount(req('https://room.test/'))).toBe(true);
    expect(shouldCount(req('https://room.test/', 'GET', { 'user-agent': 'Googlebot' }))).toBe(false);
  });

  it('writes only the daily aggregate and resolves database failures', async () => {
    const run = vi.fn(async () => ({}));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn((_sql: string) => ({ bind }));
    const ledger = { prepare } as unknown as D1Database;
    await countVisit(req('https://room.test/?via=judges', 'GET', { 'user-agent': 'Mozilla/5.0' }), { LEDGER: ledger }, 'roomweft');
    expect(prepare.mock.calls[0][0]).toContain('ON CONFLICT (day, app, kind, via, src)');
    expect(bind).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), 'roomweft', 'page', 'judges', 'none');
    const broken = { prepare: () => { throw new Error('database unavailable'); } } as unknown as D1Database;
    await expect(countVisit(req('https://room.test/', 'GET', { 'user-agent': 'Mozilla/5.0' }), { LEDGER: broken }, 'roomweft')).resolves.toBeUndefined();
  });
});
