import type { ApiError } from '../shared/api-types';
export function errorResponse(status: number, code: string, error: string): Response {
  return Response.json({ error, code } satisfies ApiError, { status });
}
export function visitorCookie(request: Request): { id: string; cookie?: string } {
  const value = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('rw_vid='))?.slice(7);
  if (value && /^[a-f\d]{32}$/i.test(value)) return { id: value };
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  return { id, cookie: `rw_vid=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000` };
}
export function finish(response: Response, cookie?: string): Response {
  const result = new Response(response.body, response);
  if (cookie) result.headers.append('Set-Cookie', cookie);
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Referrer-Policy', 'same-origin');
  result.headers.set('Cache-Control', 'no-store');
  if (result.headers.get('content-type')?.includes('text/html')) {
    result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://cdn.trychannel3.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://www.sandbox.paypal.com");
    result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }
  return result;
}
