import type { State } from './state';
import type { Candidate, DesignView, SlotView } from '../shared/api-types';
import type { SlotId } from '../shared/room';
import { STYLES, OWNED_ITEMS } from '../shared/room';
import { budgetText, checkoutAllowed, fitBadge, money, paymentLocked, quoteChanged, receiptStateText, refundText, slotLabel, unverifiedItemsText } from './helpers';
import { swatches } from './theme';

export interface Actions {
  retry: () => void; style: (id: string) => void; budget: (cents: number) => void; lock: (id: string) => void;
  design: (live: boolean) => void; swap: (slot: SlotId, id: string) => void; quote: () => void; checkout: () => void;
  refund: (id: SlotId) => void; refreshReceipt: () => void;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
const panelFocus = new WeakMap<HTMLElement, number>();
function button(text: string, action: () => void, disabled = false, testId?: string): HTMLButtonElement { const node = el('button', text); node.type = 'button'; node.disabled = disabled; if (testId) node.dataset.testid = testId; node.addEventListener('click', action); return node; }
function objectLine(id: string, index: number): HTMLDivElement {
  const node = el('div', '', 'object-line'); node.dataset.object = id; node.tabIndex = 0;
  const swatch = el('span', '', 'swatch'); swatch.style.background = swatches[index % swatches.length]; node.append(swatch); return node;
}
function section(number: number, title: string): HTMLElement { const node = el('section', '', 'step'); const heading = el('h2'); heading.append(el('span', String(number), 'step-number'), document.createTextNode(title)); node.append(heading); return node; }
function retailer(pick: Candidate): HTMLAnchorElement {
  const link = el('a', 'Retailer page (not part of the sandbox checkout)');
  try { const url = new URL(pick.url); if (url.protocol === 'https:') link.href = url.href; } catch { /* Keep the listing text if its URL is missing. */ }
  link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
}
function candidate(card: HTMLElement, pick: Candidate): void {
  if (pick.image) { try { const url = new URL(pick.image); if (url.protocol === 'https:') { const image = el('img'); image.src = url.href; image.alt = pick.title; image.loading = 'lazy'; image.width = 88; image.height = 88; image.addEventListener('error', () => image.remove(), { once: true }); card.append(image); } } catch { /* The text listing remains available. */ } }
  card.append(el('small', pick.domain), el('h3', pick.title), el('strong', money(pick.priceCents)), el('p', pick.dims ? `${pick.dims.w} x ${pick.dims.d} x ${pick.dims.h} cm` : 'Size not listed'));
}
function pickCard(slot: SlotView, design: DesignView, state: State, actions: Actions, index: number): HTMLElement {
  const card = el('article', '', 'pick'); card.dataset.object = slot.slot; card.dataset.testid = `slot-${slot.slot}`; card.tabIndex = 0;
  const heading = objectLine(slot.slot, index); heading.append(el('strong', slotLabel(slot.slot))); card.append(heading);
  if (!slot.pick) { card.append(el('p', slot.note ?? 'No listing found. Try another style or search again.', 'amber')); return card; }
  candidate(card, slot.pick);
  card.append(el('p', slot.by === 'ai' ? `Picked for taste by the model. ${slot.reason}` : slot.by === 'recorded' ? `Picked in the recorded run. ${slot.reason}` : `Picked by rules. ${slot.reason}`, 'pick-reason'));
  const badge = fitBadge(design.fit, slot.slot); card.append(el('p', badge.text, `badge ${badge.tone}`));
  const best = slot.alternates.find(alternate => alternate.fit.passes && alternate.verified);
  if (badge.tone === 'alarm' && best) card.append(button('Swap for one that fits', () => actions.swap(slot.slot, best.candidate.id), state.busy || paymentLocked(state.quote), `swap-${slot.slot}`));
  if (slot.alternates.length) {
    const other = el('details'); other.append(el('summary', 'See other options'));
    for (const [index, alternate] of slot.alternates.entries()) {
      const option = el('div', '', 'alternate'); option.append(el('strong', alternate.candidate.title), el('p', `${money(alternate.candidate.priceCents)} (${alternate.priceDeltaCents >= 0 ? '+' : ''}${money(alternate.priceDeltaCents)})`), el('p', !alternate.verified ? 'Fit unverified' : alternate.fit.passes ? 'Fits' : alternate.fit.messages.join(' '), !alternate.verified ? 'amber' : alternate.fit.passes ? 'moss' : 'alarm'));
      option.append(button('Choose this item', () => actions.swap(slot.slot, alternate.candidate.id), state.busy || paymentLocked(state.quote), badge.tone === 'alarm' && best || index > 0 ? `alternate-${slot.slot}-${index}` : `swap-${slot.slot}`)); other.append(option);
    }
    card.append(other);
  }
  card.append(retailer(slot.pick)); return card;
}
export function renderPanel(root: HTMLElement, state: State, actions: Actions): void {
  const focusable = 'button, input, select, summary, a[href], [tabindex]';
  const active = document.activeElement;
  const currentFocus = Array.from(root.querySelectorAll<HTMLElement>(focusable)).indexOf(active as HTMLElement);
  const focused = currentFocus >= 0 ? currentFocus : active === document.body ? panelFocus.get(root) ?? -1 : -1;
  if (focused >= 0) panelFocus.set(root, focused); else panelFocus.delete(root);
  const openDetails = Array.from(root.querySelectorAll('details')).map(node => node.open);
  const fragment = document.createDocumentFragment();
  const messages = el('div'); messages.setAttribute('role', state.error ? 'alert' : 'status'); messages.setAttribute('aria-live', 'polite');
  if (state.error) messages.append(el('p', state.error, 'error-card'));
  if (state.notice) messages.append(el('p', state.notice, 'notice'));
  if (state.busy) messages.append(el('p', 'Working on your room…', 'notice')); fragment.append(messages);
  if (!state.ready) { const failure = el('section', '', 'error-card'); failure.append(el('h2', 'Your room is not ready yet'), el('p', 'The room service could not load. Please try again.'), button('Retry', actions.retry, state.busy)); fragment.append(failure); root.replaceChildren(fragment); return; }
  const room = section(1, 'Your room'); room.append(el('p', 'Your own furniture stays. RoomWeft fits the rest around it.'));
  OWNED_ITEMS.forEach((item, index) => {
    const owned = state.owned.find(entry => entry.id === item.id); const row = objectLine(item.id, index); row.append(el('strong', item.label), el('small', owned?.locked ? 'Locked in place' : 'Movable'));
    const lock = button(owned?.locked ? 'Unlock' : 'Lock', () => actions.lock(item.id), state.busy || paymentLocked(state.quote)); lock.dataset.testid = `lock-${item.id}`; lock.setAttribute('aria-label', `${owned?.locked ? 'Unlock' : 'Lock'} ${item.label}`); lock.setAttribute('aria-pressed', String(owned?.locked ?? false)); row.append(lock); room.append(row);
  }); fragment.append(room);
  const style = section(2, 'Style and budget'); const choices = el('div', '', 'styles');
  STYLES.forEach(option => {
    const card = button('', () => actions.style(option.id), state.busy || paymentLocked(state.quote)); card.className = 'style-card'; card.dataset.testid = `style-${option.id}`; card.setAttribute('aria-pressed', String(state.style === option.id));
    const strip = el('span', '', 'palette'); [option.palette.floor, option.palette.wall, option.palette.accent].forEach(colour => { const swatch = el('i'); swatch.style.background = colour; strip.append(swatch); }); card.append(strip, el('strong', option.label), el('small', option.blurb)); choices.append(card);
  }); style.append(choices);
  const budgetControl = el('div', '', 'budget-control');
  const label = el('label', 'Budget'); label.htmlFor = 'budget'; const field = el('div', '', 'budget-field'); field.append(el('span', '$', 'budget-prefix'));
  const slider = el('input'); slider.id = 'budget'; slider.dataset.testid = 'budget'; slider.type = 'number'; slider.min = '150'; slider.max = '3000'; slider.step = '1'; slider.value = String(state.budget / 100); slider.setAttribute('aria-label', 'Budget'); slider.disabled = state.busy || paymentLocked(state.quote); field.append(slider); budgetControl.append(label, field);
  let submitted = false;
  const submitBudget = (): void => {
    const cents = Number(slider.value) * 100;
    if (submitted || !slider.checkValidity() || cents === state.budget) return;
    submitted = true; actions.budget(cents);
  };
  slider.addEventListener('blur', submitBudget);
  slider.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submitBudget(); } });
  const designButtons = el('div', '', 'buttons design-actions'); designButtons.append(button('Use recorded run', () => actions.design(false), state.busy || paymentLocked(state.quote), 'use-recorded'), button('Search live', () => actions.design(true), state.busy || paymentLocked(state.quote) || !state.status?.search.live || state.status.visitor.liveDesignsLeft === 0, 'search-live'));
  const budgetRow = el('div', '', 'budget-row'); budgetRow.append(budgetControl, designButtons); style.append(budgetRow, el('small', `${state.status?.visitor.liveDesignsLeft ?? 0} live designs left today. Recorded runs are instant and free.`)); fragment.append(style);
  const picks = section(3, 'Picks'); if (state.design) state.design.slots.forEach((slot, index) => picks.append(pickCard(slot, state.design!, state, actions, index))); fragment.append(picks);
  const basket = section(4, 'Basket'); const design = state.design;
  if (design) {
    design.slots.forEach((slot, index) => { if (slot.pick) { const row = objectLine(slot.slot, index); row.append(el('span', slot.pick.title), el('strong', money(slot.pick.priceCents))); basket.append(row); } });
    basket.append(el('p', `${money(design.totals.totalCents)} of ${money(design.totals.budgetCents)}`, 'total'), el('p', budgetText(design.totals.totalCents, design.totals.budgetCents), design.totals.overCents ? 'alarm' : 'moss'), el('p', unverifiedItemsText(design.totals.unverifiedCount)));
    const missing = design.slots.length !== 4 || design.slots.some(slot => !slot.pick); const blocked = !design.fit.passes || missing;
    if (blocked) basket.append(el('p', missing ? 'Fill every slot before checkout.' : 'Fix the red findings before checkout.', 'alarm'));
    for (const message of design.fit.messages) basket.append(el('small', message, 'fit-message'));
    basket.append(el('p', 'You pay our PayPal sandbox merchant with test money. No real furniture is ordered or shipped. Retailer links are separate.', 'sandbox-note'));
    const quote = state.quote; const changed = quote ? quoteChanged(quote, design) : false;
    if (quote?.state === 'capture_unknown' || quote?.state === 'capturing') basket.append(el('p', 'Checking payment', 'amber'), button('Check payment status', actions.refreshReceipt, state.busy));
    else if (quote?.state === 'paid') basket.append(el('p', 'Paid with sandbox test money.', 'moss'), button('Freeze a new quote', actions.quote, state.busy || blocked, 'freeze-quote'));
    else if (quote?.state === 'ordering') basket.append(el('p', 'Preparing your sandbox payment.', 'amber'), button('Check payment status', actions.refreshReceipt, state.busy));
    else {
      if (changed) basket.append(el('p', 'This quote is stale or the design changed. Freeze a new quote before paying.', 'amber'));
      if (quote?.error) basket.append(el('p', quote.error, 'alarm'));
      quote?.repriced?.forEach(line => basket.append(el('p', `${slotLabel(line.lineId)}: ${money(line.oldCents)} → ${line.newCents === null ? 'Unavailable' : money(line.newCents)}`, 'amber')));
      basket.append(button(quote ? 'Freeze a new quote' : 'Freeze quote', actions.quote, state.busy || blocked || paymentLocked(quote), 'freeze-quote'));
      if (quote && !changed) basket.append(el('p', `Frozen total ${money(quote.totalCents)}`), button('Pay with PayPal (sandbox)', actions.checkout, state.busy || blocked || !checkoutAllowed(quote, design) || !state.status?.sandbox.live, 'pay'));
    }
  } if (state.checkoutMessage && state.checkoutMessage !== state.notice) basket.prepend(el('p', state.checkoutMessage, 'notice')); fragment.append(basket);
  const receipt = section(5, 'Receipt'); receipt.id = 'receipt'; receipt.dataset.testid = 'receipt'; receipt.tabIndex = -1; const sale = state.receipt;
  if (sale) {
    if (sale.recorded) receipt.append(el('h3', 'Recorded sale'), el('p', 'Recorded receipt, makes no payment', 'notice'));
    receipt.append(el('p', `Order ${sale.orderId ?? 'Not yet available'}`), el('p', `Capture ${sale.captureId ?? 'Not yet available'}`));
    const receiptState = el('p', receiptStateText(sale.quote.state, sale.recorded), 'moss'); receiptState.dataset.testid = 'receipt-state'; receipt.append(receiptState);
    if (sale.amountMismatch) receipt.append(el('p', 'The payment amount needs review. Please check payment status.', 'alarm'));
    sale.lines.forEach((line, index) => {
      const row = objectLine(line.roomObjectId, index); row.classList.add('receipt-line'); row.append(el('span', line.title), el('strong', money(line.priceCents)));
      if (line.refund) row.append(el('small', refundText(line.refund.state), line.refund.state === 'completed' ? 'moss' : line.refund.state === 'failed' ? 'alarm' : 'amber'));
      if (sale.plan.some(item => item.roomObjectId === line.roomObjectId && item.status === 'returned')) row.append(el('small', 'Returned', 'moss'));
      row.append(button('Refund this item', () => actions.refund(line.lineId), state.busy || sale.recorded === true || !sale.captureId || !!line.refund || sale.quote.state !== 'paid', `refund-${line.lineId}`)); receipt.append(row);
    });
    if (sale.plan.some(line => line.status === 'returned')) receipt.append(el('p', 'The room plan and the receipt now differ. Freeze a new quote to buy a replacement.', 'notice'));
    if (!sale.recorded) receipt.append(button('Refresh receipt', actions.refreshReceipt, state.busy));
  } else receipt.append(el('p', 'Your sandbox receipt appears here after payment.')); fragment.append(receipt);
  const judges = el('details', '', 'judges'); judges.dataset.testid = 'judges'; judges.append(el('summary', 'For judges')); const path = el('ol'); ['Start with the recorded room. Keep your own desk.', 'Swap the red chair for one that fits.', 'Try Plan, then Walk through the room.', 'Freeze a quote. Pay with sandbox test money. Refund one item.'].forEach(text => path.append(el('li', text))); judges.append(path);
  if (state.status?.judgeLogin) { judges.append(el('p', 'Sandbox buyer login'), el('p', state.status.judgeLogin.email)); const password = el('p', state.status.judgeLogin.password); password.hidden = true; const reveal = button('Show sandbox buyer password', () => { password.hidden = !password.hidden; reveal.textContent = password.hidden ? 'Show sandbox buyer password' : 'Hide sandbox buyer password'; }); judges.append(reveal, password); }
  fragment.append(judges); root.replaceChildren(fragment);
  root.querySelectorAll('details').forEach((node, index) => { node.open = openDetails[index] ?? false; });
  if (focused >= 0) root.querySelectorAll<HTMLElement>(focusable)[focused]?.focus({ preventScroll: true });
}
export function renderStatus(root: HTMLElement, state: State): void {
  root.replaceChildren();
  for (const [key, label] of [['search', 'Live search'], ['ai', 'Live AI'], ['sandbox', 'Live sandbox']] as const) { const live = state.status?.[key].live; root.append(el('span', `${label}${live ? '' : ' off today'}`, `status-pill ${live ? 'on' : 'off'}`)); }
  const design = state.design; const mode = document.querySelector('#mode-label'); if (mode) mode.textContent = design?.mode === 'recorded' ? `Recorded run from ${recordedDate(design.capturedAt)}` : design?.mode === 'rules' ? 'Picked by rules, no AI today' : design ? 'Live design' : 'Loading your room';
}
export function recordedDate(value?: string): string {
  if (!value) return 'date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'date unavailable';
  const parts = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(entry => entry.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}`;
}
