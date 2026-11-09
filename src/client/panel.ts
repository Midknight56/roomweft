import type { State } from './state';
import type { Candidate, DesignView, SlotView } from '../shared/api-types';
import type { SlotId } from '../shared/room';
import { DEFAULT_ROOM_SPEC, STYLES, OWNED_ITEMS, SLOTS, slotCapCents, type RoomSpec } from '../shared/room';
import { budgetText, checkoutAllowed, doorTightWarning, eventTimeText, failedChecks, fitBadge, money, paymentLocked, paypalEventName, quoteChanged, receiptStateText, refundText, slotLabel, unverifiedItemsText } from './helpers';
import { swatches } from './theme';
import { missingSizeText } from './helpers';

export interface Actions {
  brief: (text: string) => void; retry: () => void; style: (id: string) => void; budget: (cents: number) => void; lock: (id: string) => void;
  design: (live: boolean) => void; swap: (slot: SlotId, id: string) => void; quote: () => void; checkout: (method?: 'paypal' | 'card') => void;
  refund: (id: SlotId) => void; refreshReceipt: () => void; roomField: (field: string, value: string) => void; roomApply: () => void; replace: (id: SlotId, quoteId?: string) => void; openReceipt: (quoteId: string) => void;
  select?: (id: string) => void;
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
  const link = el('a', 'Retailer page (separate from checkout)');
  try { const url = new URL(pick.url); if (url.protocol === 'https:') link.href = url.href; } catch { /* Keep the listing text if its URL is missing. */ }
  link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
}
function candidate(card: HTMLElement, pick: Candidate): void {
  if (pick.image) { try { const url = new URL(pick.image); if (url.protocol === 'https:') { const image = el('img'); image.src = url.href; image.alt = pick.title; image.loading = 'lazy'; image.width = 128; image.height = 128; image.addEventListener('error', () => image.remove(), { once: true }); card.append(image); } } catch { /* The text listing remains available. */ } }
  card.append(el('small', pick.domain), el('h3', pick.title), el('strong', money(pick.priceCents)), el('p', pick.dims ? `${pick.dims.w} x ${pick.dims.d} x ${pick.dims.h} cm` : missingSizeText(pick), 'pick-size'));
}
function renderSummary(design: DesignView, actions: Actions, root: HTMLElement): HTMLElement {
  const summary = el('section', '', 'summary');
  summary.dataset.testid = 'summary';
  const facts = el('div', '', 'summary-facts');
  const totalFact = el('span', '', 'summary-fact');
  totalFact.append(el('strong', money(design.totals.totalCents)), document.createTextNode(` of ${money(design.totals.budgetCents)}`));
  const budgetFact = el('span', '', `summary-fact ${design.totals.overCents ? 'alarm' : 'moss'}`);
  if (design.totals.overCents) {
    budgetFact.append(el('strong', money(design.totals.overCents)), document.createTextNode(' over'));
  } else {
    budgetFact.append(el('strong', money(design.totals.budgetCents - design.totals.totalCents)), document.createTextNode(' left'));
  }
  const failed = failedChecks(design);
  const failedFact = el('span', '', `summary-fact ${failed.count ? 'alarm' : ''}`);
  failedFact.append(el('strong', String(failed.count)), document.createTextNode(` ${failed.count === 1 ? 'failed check' : 'failed checks'}`));
  const unverifiedFact = el('span', '', `summary-fact ${design.totals.unverifiedCount ? 'amber' : ''}`);
  unverifiedFact.append(el('strong', String(design.totals.unverifiedCount)), document.createTextNode(` ${design.totals.unverifiedCount === 1 ? 'unverified piece' : 'unverified pieces'}`));
  facts.append(totalFact, budgetFact, failedFact, unverifiedFact);
  summary.append(facts);
  if (failed.count > 0 && failed.objectId) {
    const objectId = failed.objectId;
    const buttonLabel = `Fix the ${(failed.objectLabel ?? objectId).toLowerCase()}`;
    const fixButton = button(buttonLabel, () => {
      actions.select?.(objectId);
      const card = root.querySelector<HTMLElement>(`[data-object="${objectId}"]`) ?? document.querySelector<HTMLElement>(`[data-testid="slot-${objectId}"]`);
      card?.scrollIntoView({ block: 'nearest' });
      const swapButton = card?.querySelector<HTMLButtonElement>(`[data-testid="swap-${objectId}"]`)
        ?? card?.querySelector<HTMLButtonElement>('[data-testid^="swap-"]')
        ?? card?.querySelector<HTMLButtonElement>('button');
      if (swapButton) swapButton.focus();
      else card?.focus();
    }, false, 'summary-fix');
    fixButton.className = 'summary-fix';
    summary.append(fixButton);
  }
  return summary;
}
function pickCard(slot: SlotView, design: DesignView, state: State, actions: Actions, index: number): HTMLElement {
  const card = el('article', '', 'pick'); card.dataset.object = slot.slot; card.dataset.testid = `slot-${slot.slot}`; card.tabIndex = 0;
  const heading = objectLine(slot.slot, index); heading.append(el('strong', slotLabel(slot.slot))); card.append(heading);
  if (!slot.pick) {
    const cap = slotCapCents(design.budgetCents, slot.slot);
    const moneyVal = `$${Number((cap / 100).toFixed(2))}`;
    card.append(el('p', slot.note ?? `Nothing under the ${moneyVal} share for this piece. Raise the budget or swap.`, 'amber'));
    if (slot.alternates.length) {
      const other = el('details'); other.append(el('summary', 'See other options'));
      for (const [idx, alternate] of slot.alternates.entries()) {
        const option = el('div', '', 'alternate'); option.append(el('strong', alternate.candidate.title), el('p', `${money(alternate.candidate.priceCents)} (${alternate.priceDeltaCents >= 0 ? '+' : ''}${money(alternate.priceDeltaCents)})`), el('p', !alternate.verified ? 'Fit unverified' : alternate.fit.passes ? 'Fits' : alternate.fit.messages.join(' '), !alternate.verified ? 'amber' : alternate.fit.passes ? 'moss' : 'alarm'));
        option.append(button('Choose this item', () => actions.swap(slot.slot, alternate.candidate.id), state.busy || paymentLocked(state.quote), idx > 0 ? `alternate-${slot.slot}-${idx}` : `swap-${slot.slot}`)); other.append(option);
      }
      card.append(other);
    }
    return card;
  }
  candidate(card, slot.pick);
  if (slot.unavailable) card.append(el('p', 'No longer available at this shop. Swap for another.', 'alarm'));
  card.append(el('p', slot.by === 'ai' ? `Picked for taste by the model. ${slot.reason}` : slot.by === 'recorded' ? `Picked in the recorded run. ${slot.reason}` : `Picked by rules. ${slot.reason}`, 'pick-reason'));
  const badge = fitBadge(design.fit, slot.slot); card.append(el('p', badge.text, `badge ${badge.tone}`));
  const tight = (design.fit.tight ?? []).find(item => item.id === slot.slot);
  const warning = doorTightWarning(tight);
  if (warning) card.append(el('p', warning, 'amber'));
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
  if (state.design) fragment.append(renderSummary(state.design, actions, root));
  const room = section(1, 'Your room'); room.append(el('p', 'Your own furniture stays. RoomWeft fits the rest around it.'));
  OWNED_ITEMS.forEach((item, index) => {
    const owned = state.owned.find(entry => entry.id === item.id); const row = objectLine(item.id, index); row.append(el('strong', item.label), el('small', owned?.locked ? 'Locked in place' : 'Movable'));
    const lock = button(owned?.locked ? 'Unlock' : 'Lock', () => actions.lock(item.id), state.busy || paymentLocked(state.quote)); lock.dataset.testid = `lock-${item.id}`; lock.setAttribute('aria-label', `${owned?.locked ? 'Unlock' : 'Lock'} ${item.label}`); lock.setAttribute('aria-pressed', String(owned?.locked ?? false)); row.append(lock); room.append(row);
  }); room.append(roomSize(state, actions)); fragment.append(room);
  const style = section(2, 'Style and budget'); const choices = el('div', '', 'styles');
  STYLES.forEach(option => {
    const card = button('', () => actions.style(option.id), state.busy || paymentLocked(state.quote)); card.className = 'style-card'; card.dataset.testid = `style-${option.id}`; card.setAttribute('aria-pressed', String(state.style === option.id));
    const strip = el('span', '', 'palette'); [option.palette.floor, option.palette.wall, option.palette.accent].forEach(colour => { const swatch = el('i'); swatch.style.background = colour; strip.append(swatch); }); card.append(strip, el('strong', option.label), el('small', option.blurb)); choices.append(card);
  }); style.append(choices);
  const briefLabel = el('label', 'Tell RoomWeft about the room'); briefLabel.htmlFor = 'brief';
  const briefField = el('input'); briefField.id = 'brief'; briefField.type = 'text'; briefField.maxLength = 200;
  briefField.placeholder = 'I read in the evening, the window side is cold, under $700';
  briefField.value = state.brief ?? ''; briefField.disabled = state.busy || paymentLocked(state.quote);
  briefField.addEventListener('input', () => actions.brief(briefField.value));
  style.append(briefLabel, briefField);
  if (state.design?.brief) {
    const brief = state.design.brief;
    const box = el('div', '', 'brief-box'); box.dataset.testid = 'brief-understood'; box.dataset.by = brief.by;
    box.append(el('h3', 'What RoomWeft understood'));
    if (brief.text) box.append(el('p', brief.text));
    if (brief.by === 'rules') box.append(el('small', 'Brief read by rules'));
    box.append(el('p', brief.understood));
    const searchDetails = el('details');
    searchDetails.append(el('summary', 'Search details'));
    for (const slot of SLOTS) searchDetails.append(el('small', `Searched: ${brief.queries[slot.id]}`));
    box.append(searchDetails);
    style.append(box);
  }
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
  const designButtons = el('div', '', 'buttons design-actions'); designButtons.append(button('Search live', () => actions.design(true), state.busy || paymentLocked(state.quote) || !state.status?.search.live || state.status.visitor.liveDesignsLeft === 0, 'search-live'));
  const budgetRow = el('div', '', 'budget-row'); budgetRow.append(budgetControl, designButtons); const reset = button('Reset to the saved run', () => actions.design(false), state.busy || paymentLocked(state.quote), 'use-recorded'); reset.className = 'text-link'; budgetControl.append(reset); style.append(budgetRow, el('small', `${state.status?.visitor.liveDesignsLeft ?? 0} live designs left today. Recorded runs are instant and free.`)); fragment.append(style);
  const picks = section(3, 'Picks');
  picks.id = 'picks';
  const backToRoom = el('a', 'Back to room', 'back-to-room');
  backToRoom.href = '#room';
  backToRoom.setAttribute('aria-label', 'Back to room');
  picks.append(backToRoom);
  if (state.design) state.design.slots.forEach((slot, index) => picks.append(pickCard(slot, state.design!, state, actions, index)));
  fragment.append(picks);
  const basket = section(4, 'Basket');
  basket.id = 'basket';
  const design = state.design;
  if (design) {
    design.slots.forEach((slot, index) => { if (slot.pick) { const row = objectLine(slot.slot, index); row.append(el('span', slot.pick.title), el('strong', money(slot.pick.priceCents))); basket.append(row); } });
    basket.append(el('p', `${money(design.totals.totalCents)} of ${money(design.totals.budgetCents)}`, 'total'), el('p', budgetText(design.totals.totalCents, design.totals.budgetCents), design.totals.overCents ? 'alarm' : 'moss'), el('p', unverifiedItemsText(design.totals.unverifiedCount)));
    const hasPicks = design.slots.some(slot => slot.pick); const blocked = !design.fit.passes || !hasPicks;
    if (blocked) basket.append(el('p', !hasPicks ? 'Pick at least one item before checkout.' : 'Fix the red findings before checkout.', 'alarm'));
    for (const message of design.fit.messages) basket.append(el('small', message, 'fit-message'));
    basket.append(el('p', 'You pay RoomWeft through PayPal. Retailer links are separate.', 'sandbox-note'));
    const quote = state.quote; const changed = quote ? quoteChanged(quote, design) : false;
    if (quote?.state === 'capture_unknown' || quote?.state === 'capturing') basket.append(el('p', 'Checking payment', 'amber'), button('Check payment status', actions.refreshReceipt, state.busy));
    else if (quote?.state === 'paid') basket.append(el('p', 'Paid with PayPal.', 'moss'), button('Freeze a new quote', actions.quote, state.busy || blocked, 'freeze-quote'));
    else if (quote?.state === 'ordering') basket.append(el('p', 'Preparing your PayPal payment.', 'amber'), button('Check payment status', actions.refreshReceipt, state.busy));
    else {
      const again = quote?.replaces && changed ? quote.replaces : null;
      if (changed) basket.append(el('p', again ? (quote?.repriced?.length ? 'Prices changed at the shop. Make a new replacement quote.' : 'The room changed. Make a new replacement quote.')
        : quote?.repriced?.length ? 'Prices changed at the shop. Freeze a new quote.' : 'This quote is stale or the design changed. Freeze a new quote before paying.', 'amber'));
      if (quote?.error) basket.append(el('p', quote.error, 'alarm'));
      quote?.repriced?.forEach(line => basket.append(el('p', `${slotLabel(line.lineId)}: ${money(line.oldCents)} → ${line.newCents === null ? 'Unavailable' : money(line.newCents)}`, 'amber')));
      if (again) basket.append(button('New replacement quote', () => actions.replace(again.lineId, again.quoteId), state.busy || paymentLocked(quote), 'replace-again'));
      else basket.append(button(quote ? 'Freeze a new quote' : 'Freeze quote', actions.quote, state.busy || blocked || paymentLocked(quote), 'freeze-quote'));
      const payDisabled = state.busy || blocked || !quote || changed || !checkoutAllowed(quote, design) || !state.status?.sandbox.live;
      if (quote?.replaces && !changed) {
        const replacement = el('div', '', 'replacement-quote'); replacement.dataset.testid = 'replacement-quote';
        replacement.append(el('p', 'Replacement quote: 1 piece', 'moss'));
        quote.lines.forEach(line => replacement.append(el('p', `${line.title} ${money(line.priceCents)}`)));
        replacement.append(el('small', 'Only this piece is charged. The pieces you kept are not charged again.'));
        basket.append(replacement);
      }
      if (quote && !changed) basket.append(el('p', `Frozen total ${money(quote.totalCents)}`));
      const payments = el('div', '', 'buttons');
      payments.append(button('Pay by card', () => actions.checkout('card'), payDisabled, 'pay-card'), button('Pay with PayPal', () => actions.checkout('paypal'), payDisabled, 'pay'));
      basket.append(payments, el('small', 'Card payments run through PayPal.'));
    }
  } if (state.checkoutMessage && state.checkoutMessage !== state.notice) basket.prepend(el('p', state.checkoutMessage, 'notice')); fragment.append(basket);
  const receipt = section(5, 'Receipt'); receipt.id = 'receipt'; receipt.dataset.testid = 'receipt'; receipt.tabIndex = -1; const sale = state.receipt;
  if (sale) {
    if (sale.recorded) receipt.append(el('h3', 'Recorded sale'), el('p', 'Recorded receipt, makes no payment', 'notice'));
    receipt.append(el('p', `Order ${sale.orderId ?? 'Not yet available'}`), el('p', `Capture ${sale.captureId ?? 'Not yet available'}`));
    const receiptState = el('p', receiptStateText(sale.quote.state, sale.recorded), 'moss'); receiptState.dataset.testid = 'receipt-state'; receipt.append(receiptState);
    if (sale.amountMismatch) receipt.append(el('p', 'The payment amount needs review. Please check payment status.', 'alarm'));
    if (sale.quote.replaces) {
      const link = el('div', '', 'replacement-receipt'); link.dataset.testid = 'replacement-receipt';
      const first = sale.quote.replaces.quoteId;
      link.append(el('p', `Replacement for the ${slotLabel(sale.quote.replaces.lineId).toLowerCase()} returned on receipt ${first.slice(0, 8)}`), button('Open that receipt', () => actions.openReceipt(first), state.busy, 'open-first-receipt'));
      receipt.append(link);
    }
    sale.lines.forEach((line, index) => {
      const row = objectLine(line.roomObjectId, index); row.classList.add('receipt-line'); row.append(el('span', line.title), el('strong', money(line.priceCents)));
      if (line.refund) row.append(el('small', refundText(line.refund.state), line.refund.state === 'completed' ? 'moss' : line.refund.state === 'failed' ? 'alarm' : 'amber'));
      if (sale.plan.some(item => item.roomObjectId === line.roomObjectId && item.status === 'returned')) row.append(el('small', 'Returned', 'moss'));
      row.append(button('Refund this item', () => actions.refund(line.lineId), state.busy || sale.recorded === true || !sale.captureId || !!line.refund || sale.quote.state !== 'paid', `refund-${line.lineId}`));
      if (line.refund?.state === 'completed' && !sale.recorded) {
        const done = sale.replacements?.find(item => item.lineId === line.lineId && item.state === 'paid');
        if (done) row.append(el('small', 'Replaced', 'moss'), button('Open the replacement receipt', () => actions.openReceipt(done.quoteId), state.busy));
        else row.append(button('Replace this item', () => actions.replace(line.lineId), state.busy || paymentLocked(state.quote), 'replace-item'));
      }
      receipt.append(row);
    });
    if (sale.plan.some(line => line.status === 'returned')) receipt.append(el('p', 'The room plan and the receipt now differ. Replace the returned piece with a one piece quote.', 'notice'));
    if (!sale.recorded) {
      receipt.append(el('h3', 'PayPal events'));
      if (sale.events && sale.events.length > 0) {
        sale.events.forEach(event => {
          const row = el('div', '', 'receipt-event');
          row.append(
            el('strong', paypalEventName(event.type)),
            el('span', eventTimeText(event.receivedAt)),
            el('small', 'Signature verified', 'moss'),
          );
          receipt.append(row);
        });
      } else {
        receipt.append(el('p', 'No PayPal events yet. They arrive within a minute.'));
      }
      const refresh = button('Refresh receipt', actions.refreshReceipt, state.busy);
      refresh.className = 'text-link';
      receipt.append(refresh);
    }
  } else receipt.append(el('p', 'Your receipt appears here after payment.')); fragment.append(receipt);
  const judges = el('details', '', 'judges'); judges.dataset.testid = 'judges'; judges.append(el('summary', 'For judges')); const path = el('ol'); ['Pay by card. No login needed.', 'Start with the recorded room. Keep your own desk.', 'Swap the red chair for one that fits.', 'Try Plan, then Walk through the room.', 'Freeze a quote. Pay. Refund one item.'].forEach(text => path.append(el('li', text))); judges.append(path);
  if (state.status?.judgeLogin) { judges.append(el('p', 'PayPal buyer login'), el('p', state.status.judgeLogin.email)); const password = el('p', state.status.judgeLogin.password); password.hidden = true; const reveal = button('Show buyer password', () => { password.hidden = !password.hidden; reveal.textContent = password.hidden ? 'Show buyer password' : 'Hide buyer password'; }); judges.append(reveal, password); }
  fragment.append(judges); root.replaceChildren(fragment);
  root.querySelectorAll('details').forEach((node, index) => { node.open = openDetails[index] ?? false; });
  if (focused >= 0) root.querySelectorAll<HTMLElement>(focusable)[focused]?.focus({ preventScroll: true });
}
const OWNED_SIZES: [string, string, keyof RoomSpec['owned']][] = [['desk', 'Desk', 'desk'], ['desk-chair', 'Desk chair', 'deskChair'], ['bookshelf', 'Bookshelf', 'bookshelf']];
function roomSize(state: State, actions: Actions): HTMLElement {
  const spec = state.design?.roomSpec ?? DEFAULT_ROOM_SPEC;
  const locked = state.busy || paymentLocked(state.quote) || !state.design;
  const box = el('div', '', 'room-size'); box.dataset.testid = 'room-size';
  box.append(el('h3', 'Room size'), el('small', 'Rectangular rooms with one door on the south wall. Sizes in cm.'));
  const field = (name: string, testId: string, label: string, value: number): HTMLElement => {
    const wrap = el('div', '', 'room-field'); const id = `room-field-${name}`;
    const caption = el('label', label); caption.htmlFor = id;
    const input = el('input'); input.id = id; input.type = 'number'; input.inputMode = 'numeric'; input.step = '1'; input.dataset.testid = testId;
    input.value = state.roomDraft?.[name] ?? String(value); input.disabled = locked;
    input.addEventListener('input', () => actions.roomField(name, input.value));
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); actions.roomApply(); } });
    wrap.append(caption, input);
    const error = state.roomErrors?.find(item => item.field === name);
    if (error) { const message = el('small', error.message, 'alarm'); message.dataset.testid = 'room-error'; message.id = `${id}-error`; input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', message.id); wrap.append(message); }
    return wrap;
  };
  const grid = el('div', '', 'room-grid');
  grid.append(field('width', 'room-width', 'Width', spec.width), field('depth', 'room-depth', 'Depth', spec.depth),
    field('door-left', 'door-left', 'Door from west wall', spec.door.left), field('door-width', 'door-width', 'Door width', spec.door.width));
  const sizes = el('details', '', 'furniture-sizes'); sizes.dataset.testid = 'furniture-sizes'; sizes.append(el('summary', 'Furniture sizes'));
  for (const [id, label, key] of OWNED_SIZES) {
    const row = el('div', '', 'room-grid'); row.append(el('strong', label));
    const size = spec.owned[key];
    row.append(field(`size-${id}-w`, `size-${id}-w`, 'Width', size.w), field(`size-${id}-d`, `size-${id}-d`, 'Depth', size.d), field(`size-${id}-h`, `size-${id}-h`, 'Height', size.h));
    sizes.append(row);
  }
  if (state.roomErrors?.some(item => item.field.startsWith('size-'))) sizes.open = true;
  box.append(grid, sizes, button('Apply', actions.roomApply, locked, 'room-apply'));
  return box;
}
export function renderStatus(root: HTMLElement, state: State): void {
  root.replaceChildren();
  for (const [key, label] of [['search', 'Live search'], ['ai', 'Live AI'], ['sandbox', 'Live payments']] as const) { const live = state.status?.[key].live; root.append(el('span', `${label}${live ? '' : ' off today'}`, `status-pill ${live ? 'on' : 'off'}`)); }
  const design = state.design; const mode = document.querySelector('#mode-label'); if (mode) mode.textContent = design?.mode === 'recorded' ? `Saved live run from ${recordedDate(design.capturedAt)}. Press Search live for a new one.` : design?.mode === 'rules' ? 'Picked by rules, no AI today' : design ? 'Live design' : 'Loading your room';
}
export function recordedDate(value?: string): string {
  if (!value) return 'date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'date unavailable';
  const parts = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(entry => entry.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}`;
}
