import type { ApiError, DesignView, OwnedState, Placement, QuoteView, ReceiptView, RefundView, StatusView } from '../shared/api-types';
import type { RoomSpec, SlotId } from '../shared/room';

export class RequestError extends Error {
  constructor(message: string, public code: string, public status: number, public quote?: QuoteView, public design?: DesignView) { super(message); }
}
async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new RequestError('The room service is unavailable. Please try again.', 'unavailable', response.status);
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = value as Partial<ApiError>;
    throw new RequestError(error.error ?? 'The request could not be completed.', error.code ?? 'request_failed', response.status, error.quote, error.design);
  }
  return value as T;
}
const id = encodeURIComponent;
export const api = {
  // No scenes response shape is defined in the shared contract yet.
  scenes: (): Promise<unknown> => request('/api/scenes'),
  status: (): Promise<StatusView> => request('/api/status'),
  design: (style: string, budget: number, owned: OwnedState[], live: boolean, brief?: string, roomSpec?: RoomSpec): Promise<DesignView> => request('/api/design', { style, budget: Math.round(budget / 100), owned, live, ...(live && brief ? { brief } : {}), ...(roomSpec ? { roomSpec } : {}) }),
  room: (designId: string, roomSpec: unknown): Promise<DesignView> => request('/api/room', { designId, roomSpec }),
  swap: (designId: string, slot: SlotId, productId: string): Promise<DesignView> => request(`/api/design/${id(designId)}/swap`, { slot, productId }),
  move: (designId: string, itemId: string, placement: Placement): Promise<DesignView> => request(`/api/design/${id(designId)}/move`, { itemId, ...placement }),
  quote: (design: DesignView): Promise<QuoteView> => request('/api/quote', { designId: design.id, version: design.version }),
  checkout: (quoteId: string, method: 'paypal' | 'card'): Promise<QuoteView | ReceiptView> => request('/api/checkout', { quoteId, method }),
  receipt: (quoteId: string): Promise<ReceiptView> => request(`/api/receipt/${id(quoteId)}`),
  refund: (quoteId: string, lineId: SlotId): Promise<RefundView> => request('/api/refund', { quoteId, lineId }),
  replace: (quoteId: string, lineId: SlotId): Promise<{ quote: QuoteView; design: DesignView }> => request('/api/replace', { quoteId, lineId }),
};
