import { BODY_LIMIT } from '../limits';
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export async function bodyText(request: Request): Promise<string> {
  if (Number(request.headers.get('content-length')) > BODY_LIMIT) throw new HttpError(413, 'body_too_large', 'Keep the request under 16 KB.');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > BODY_LIMIT) { await reader.cancel(); throw new HttpError(413, 'body_too_large', 'Keep the request under 16 KB.'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new HttpError(400, 'invalid_json', 'Send valid UTF8 text.'); }
}
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await bodyText(request);
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, 'invalid_json', 'Send a JSON object.'); }
}
export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new HttpError(400, 'invalid', `Send a valid ${key}.`);
  return value;
}
export function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, 'invalid', `Send a valid ${key}.`);
  return value;
}
