import { api, RequestError } from './api';
import { store } from './state';
import { renderPanel, renderStatus } from './panel';
import type { Actions } from './panel';
import { RoomScene } from './scene';
import { controls } from './controls';
import { threads } from './thread';
import { approvalUrl, checkoutAllowed, paymentLocked, restoredDesign, roomSpecFrom, shouldHidePhoneJump } from './helpers';
import type { DesignView, ReceiptView } from '../shared/api-types';
import { DEFAULT_ROOM_SPEC, STYLES, validateRoomSpec } from '../shared/room';
import { checkoutReturn, returnNotice } from './return-state';

window.__roomweftReady = false;
const returned = checkoutReturn(location.href);
if (returned.present) history.replaceState(history.state, '', returned.cleanUrl);

const panel = document.querySelector<HTMLElement>('#panel')!; const status = document.querySelector<HTMLElement>('#status')!;
const host = document.querySelector<HTMLElement>('#room')!; const tooltip = document.querySelector<HTMLElement>('#object-label')!;
let view: RoomScene | null = null; let previous: DesignView | null = null; let previousReceipt: ReceiptView | null = null;
try { view = new RoomScene(host); } catch { const error = document.createElement('p'); error.className = 'error-card'; error.textContent = 'The 3D view needs WebGL. You can still review the room picks below.'; host.append(error); }
const thread = view ? threads(view, tooltip) : null;
const selectItem = (id: string | null): void => {
  thread?.select(id);
  (window as unknown as { __roomweftSelected?: string | null }).__roomweftSelected = id;
};
const control = view ? controls(view, async (itemId, placement) => { await run(async () => { const design = store.get().design; if (!design || paymentLocked(store.get().quote)) throw new Error('Finish the current payment before moving furniture.'); accept(await api.move(design.id, itemId, placement)); }); }, selectItem) : null;
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.addEventListener('click', () => control?.mode(button.dataset.mode as 'Overview' | 'Plan' | 'Walk')));
document.querySelector('#rotate')?.addEventListener('click', () => control?.rotate());
control?.mode('Overview');
function setupPhoneJump(): { update: () => void; destroy: () => void } {
  const bar = document.querySelector<HTMLElement>('#phone-jump');
  if (!bar || typeof IntersectionObserver === 'undefined') {
    return { update: () => {}, destroy: () => {} };
  }
  const jumpBar = bar;
  let picksVisible = false;
  let basketVisible = false;
  function sync(): void {
    jumpBar.hidden = shouldHidePhoneJump(picksVisible, basketVisible);
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.target.id === 'picks') picksVisible = entry.isIntersecting;
      if (entry.target.id === 'basket') basketVisible = entry.isIntersecting;
    }
    sync();
  }, { threshold: 0 });
  function observe(): void {
    const picks = document.querySelector('#picks');
    const basket = document.querySelector('#basket');
    if (picks) observer.observe(picks);
    if (basket) observer.observe(basket);
  }
  observe();
  return {
    update: () => {
      observer.disconnect();
      observe();
      sync();
    },
    destroy: () => {
      observer.disconnect();
    }
  };
}
const phoneJump = setupPhoneJump();
document.querySelector<HTMLAnchorElement>('.phone-jump-link')?.addEventListener('click', event => {
  const picks = document.querySelector('#picks');
  if (picks) {
    event.preventDefault();
    picks.scrollIntoView();
    history.replaceState(history.state, '', '#picks');
  }
});
panel.addEventListener('click', event => {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('.back-to-room');
  if (link) {
    const room = document.querySelector('#room');
    if (room) {
      event.preventDefault();
      room.scrollIntoView();
      history.replaceState(history.state, '', '#room');
    }
  }
});
function accept(design: DesignView): void { store.set({ design, style: design.style, budget: design.budgetCents, owned: design.owned, notice: design.swapNote ?? design.message ?? '' }); }
function clearReceiptUrl(): void {
  const url = new URL(location.href);
  if (!url.searchParams.has('receipt')) return;
  url.searchParams.delete('receipt');
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
async function run(action: () => Promise<void>): Promise<void> {
  if (store.get().busy) return; view?.loading(); store.set({ busy: true, error: '', notice: '' });
  try { await action(); } catch (error) {
    store.set({ error: error instanceof Error ? error.message : 'The request could not be completed.' });
    if (error instanceof RequestError && error.design) accept(error.design);
    if (error instanceof RequestError && error.quote) store.set({ quote: error.quote });
    if (error instanceof RequestError && error.code === 'price_unchecked' && store.get().quote) {
      store.set({ quote: { ...store.get().quote!, state: 'open' } });
    } else if (error instanceof RequestError && /stale|version|price/i.test(error.code) && store.get().quote) {
      store.set({ quote: { ...store.get().quote!, state: 'stale' } });
    }
  } finally { store.set({ busy: false }); view?.resume(); }
}
async function refreshReceipt(quoteId?: string): Promise<void> {
  const state = store.get();
  const id = quoteId ?? (paymentLocked(state.quote) ? state.quote?.id : state.receipt?.quote.id) ?? state.quote?.id ?? new URLSearchParams(location.search).get('receipt'); if (!id) return;
  const receipt = await api.receipt(id); store.set({ receipt, quote: receipt.quote });
  const url = new URL(location.href);
  if (!url.searchParams.has('receipt')) { url.searchParams.set('receipt', id); history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`); }
  if (!paymentLocked(receipt.quote)) { try { sessionStorage.removeItem('roomweft-pending-quote'); } catch { /* Browser storage is optional. */ } }
}
async function boot(): Promise<void> {
  await run(async () => {
    store.set({ checkoutMessage: returned.message });
    await api.scenes(); store.set({ ready: true });
    let receiptId = returned.receiptId;
    let saved: DesignView | null = null;
    try { receiptId ??= sessionStorage.getItem('roomweft-pending-quote'); if (receiptId) saved = restoredDesign(sessionStorage.getItem('roomweft-payment-room'), receiptId); } catch { /* Storage may be unavailable in a private session. */ }
    const result = await Promise.allSettled([api.status(), saved ? Promise.resolve(saved) : api.design(store.get().style, store.get().budget, store.get().owned, false)]);
    if (result[0].status === 'fulfilled') store.set({ status: result[0].value }); else store.set({ notice: 'Live services are unavailable today. You can use the recorded room.' });
    if (saved) accept(saved);
    else if (result[1].status === 'fulfilled') accept(result[1].value);
    else if (!receiptId) throw result[1].reason;
    if (receiptId) { await refreshReceipt(receiptId); if (!saved) store.set({ notice: 'Your receipt is loaded. The saved room was unavailable in this browser.' }); if (!returned.message) { document.querySelector<HTMLElement>('#receipt')?.focus(); document.querySelector('#receipt')?.scrollIntoView({ block: 'start' }); } }
    store.set({ notice: returnNotice(returned.message, store.get().notice) });
  });
}
const actions: Actions = {
  brief: text => { store.set({ brief: text }, false); },
  retry: () => { void boot(); }, style: style => { clearReceiptUrl(); store.set({ style, budget: (STYLES.find(s => s.id === style) ?? STYLES[0]).defaultBudget * 100 }); actions.design(false); }, budget: budget => { store.set({ budget }); actions.design(false); },
  lock: id => { void run(async () => {
    const state = store.get(); const selected = state.owned.find(item => item.id === id); if (!selected) return;
    const owned = state.owned.map(item => item.id === id || (id === 'desk' && item.id === 'desk-chair') || (id === 'desk-chair' && item.id === 'desk') ? { ...item, locked: !selected.locked } : item);
    accept(await api.design(state.style, state.budget, owned, false, undefined, state.design?.roomSpec));
  }); },
  design: live => { void run(async () => { const state = store.get(); accept(await api.design(state.style, state.budget, state.owned, live, state.brief, state.design?.roomSpec)); try { store.set({ status: await api.status() }); } catch { /* A failed status refresh leaves the design usable. */ } }); },
  roomField: (field, value) => { store.set({ roomDraft: { ...store.get().roomDraft, [field]: value } }, false); },
  roomApply: () => {
    const state = store.get(); const design = state.design; if (!design) return;
    const spec = roomSpecFrom(design.roomSpec ?? DEFAULT_ROOM_SPEC, state.roomDraft ?? {});
    const errors = validateRoomSpec(spec);
    if (errors.length) { store.set({ roomErrors: errors }); return; }
    void run(async () => { accept(await api.room(design.id, spec)); store.set({ roomDraft: {}, roomErrors: [] }); });
  },
  swap: (slot, productId) => { void run(async () => { const design = store.get().design; if (design) accept(await api.swap(design.id, slot, productId)); }); },
  quote: () => { void run(async () => { const design = store.get().design; if (design) { clearReceiptUrl(); store.set({ quote: await api.quote(design) }); } }); },
  checkout: (method = 'paypal') => { void run(async () => {
    const { quote, design } = store.get(); if (!quote || !design || !checkoutAllowed(quote, design)) throw new Error('Freeze a current quote before paying.');
    try {
      sessionStorage.setItem('roomweft-payment-room', JSON.stringify({ quoteId: quote.id, design }));
      sessionStorage.setItem('roomweft-pending-quote', quote.id);
    } catch { /* The receipt remains available even without browser storage. */ }
    store.set({ quote: { ...quote, state: 'ordering' } });
    const answer = await api.checkout(quote.id, method);
    const next = 'quote' in answer ? answer.quote : answer;
    store.set({ quote: next, ...('quote' in answer ? { receipt: answer } : {}) });
    if (next.state === 'paid') {
      if (!('quote' in answer)) await refreshReceipt(next.id);
      const url = new URL(location.href); url.searchParams.set('receipt', next.id); history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
      try { sessionStorage.removeItem('roomweft-pending-quote'); } catch { /* Storage is optional. */ }
      document.querySelector<HTMLElement>('#receipt')?.focus(); document.querySelector('#receipt')?.scrollIntoView({ block: 'start' });
    }
    if (next.approveUrl && next.state === 'approving') {
      const url = approvalUrl(next.approveUrl); if (!url) throw new Error('The PayPal approval link is unavailable.');
      location.assign(url);
    }
  }); },
  refund: lineId => { void run(async () => {
    const receipt = store.get().receipt;
    if (receipt && !receipt.recorded) {
      store.set({ receipt: { ...receipt, lines: receipt.lines.map(line => line.lineId === lineId ? { ...line, refund: { state: 'unknown', amountCents: line.priceCents, paypalId: null } } : line) } });
      await api.refund(receipt.quote.id, lineId); await refreshReceipt(receipt.quote.id);
    }
  }); },
  replace: (lineId, quoteId) => { void run(async () => {
    const receipt = store.get().receipt; const original = quoteId ?? (receipt && !receipt.recorded ? receipt.quote.id : null); if (!original) return;
    const answer = await api.replace(original, lineId);
    accept(answer.design); store.set({ quote: answer.quote });
    document.querySelector('#basket')?.scrollIntoView({ block: 'start' });
  }); },
  openReceipt: quoteId => { void run(() => refreshReceipt(quoteId)); },
  refreshReceipt: () => { void run(refreshReceipt); },
  select: id => { selectItem(id); },
};
const unsubscribe = store.subscribe(state => {
  renderPanel(panel, state, actions); renderStatus(status, state);
  phoneJump.update();
  const finding = document.querySelector<HTMLElement>('#room-finding');
  if (finding) { finding.textContent = state.design && !state.design.fit.passes ? state.design.fit.messages[0] ?? '' : ''; finding.hidden = !finding.textContent; }
  const size = document.querySelector<HTMLElement>('#room-dimensions'); const spec = state.design?.roomSpec ?? DEFAULT_ROOM_SPEC;
  if (size) size.textContent = `${spec.width} x ${spec.depth} cm`;
  if (state.design && (state.design !== previous || state.receipt !== previousReceipt)) { view?.update(state.design, state.receipt); previous = state.design; previousReceipt = state.receipt; }
});
let timer: ReturnType<typeof setTimeout> | undefined;
function poll(): void { timer = setTimeout(() => {
  const state = store.get(); const pending = state.quote && ['capturing', 'capture_unknown', 'ordering'].includes(state.quote.state) || state.receipt?.lines.some(line => line.refund && ['requesting', 'pending', 'unknown'].includes(line.refund.state));
  if (pending && !state.busy && !document.hidden) void run(refreshReceipt); poll();
}, 8000); }
window.addEventListener('pagehide', () => { clearTimeout(timer); unsubscribe(); control?.destroy(); thread?.destroy(); view?.destroy(); phoneJump.destroy(); }, { once: true });
void boot(); poll();
