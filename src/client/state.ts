import type { DesignView, OwnedState, QuoteView, ReceiptView, StatusView } from '../shared/api-types';
import { OWNED_ITEMS, STYLES } from '../shared/room';
export interface State {
  design: DesignView | null; quote: QuoteView | null; receipt: ReceiptView | null; status: StatusView | null;
  brief?: string; style: string; budget: number; owned: OwnedState[]; busy: boolean; error: string; notice: string; ready: boolean; checkoutMessage?: string;
}
let state: State = { design: null, quote: null, receipt: null, status: null, style: 'calm-studio', budget: STYLES.find(style => style.id === 'calm-studio')!.defaultBudget * 100, owned: OWNED_ITEMS.map(({ id, x, z, rot, locked }) => ({ id, x, z, rot, locked })), busy: false, error: '', notice: '', ready: false };
const listeners = new Set<(state: State) => void>();
export const store = {
  get: (): State => state,
  set: (patch: Partial<State>, notify = true): void => { state = { ...state, ...patch }; if (notify) listeners.forEach(listener => listener(state)); },
  subscribe: (listener: (state: State) => void): (() => void) => { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
};
