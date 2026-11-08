import type { RoomScene } from './scene';
import { theme } from './theme';
import { missingSizeText } from './helpers';
export function threads(view: RoomScene, tooltip: HTMLElement): { select: (id: string | null) => void; destroy: () => void } {
  const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg'); svg.classList.add('threads'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path'); path.setAttribute('fill', 'none'); path.setAttribute('stroke', theme.thread); path.setAttribute('stroke-width', '2'); path.setAttribute('pathLength', '1'); svg.append(path); document.body.append(svg);
  let selected: string | null = null; let anchor: HTMLElement | null = null; let frame = 0;
  const select = (id: string | null): void => {
    if (selected !== id && id && !matchMedia('(prefers-reduced-motion: reduce)').matches) path.animate([{ strokeDasharray: '1', strokeDashoffset: '1' }, { strokeDasharray: '1', strokeDashoffset: '0' }], { duration: 350, easing: 'ease-out' });
    selected = id; view.highlight(id);
  };
  const events = new AbortController(); const signal = events.signal;
  const enter = (event: Event): void => { const element = (event.target as Element).closest<HTMLElement>('[data-object]'); if (element) { anchor = element; select(element.dataset.object ?? null); } };
  document.addEventListener('pointerover', enter, { signal }); document.addEventListener('focusin', enter, { signal }); document.addEventListener('click', enter, { signal });
  document.addEventListener('pointerout', event => { const from = (event.target as Element).closest('[data-object]'); if (from && !from.contains(event.relatedTarget as Node | null)) { anchor = null; select(null); } }, { signal });
  document.addEventListener('focusout', () => { anchor = null; select(null); }, { signal });
  const tick = (): void => {
    frame = requestAnimationFrame(tick); const endpoint = selected ? view.project(selected) : null;
    const item = view.design?.slots.find(slot => slot.slot === selected); const owned = view.layout.find(item => item.id === selected);
    tooltip.hidden = !endpoint || !selected;
    if (endpoint && selected) {
      tooltip.textContent = `${item?.pick?.title ?? owned?.label ?? ''}\nVisual approximation\n${item?.pick && !item.pick.dims ? `${missingSizeText(item.pick)}, fit unverified` : 'Size from the listing'}`;
      if (!item) tooltip.textContent = `${owned?.label ?? ''}\nYour own furniture\n${owned?.locked ? 'Locked' : 'Movable'}`;
      const rect = view.host.getBoundingClientRect(); tooltip.style.left = `${Math.max(8, Math.min(rect.width - 220, endpoint.x - rect.left + 12))}px`; tooltip.style.top = `${Math.max(70, Math.min(rect.height - 100, endpoint.y - rect.top - 50))}px`;
    }
    if (endpoint && anchor?.isConnected) {
      const rect = anchor.getBoundingClientRect(); const x = rect.left + 9; const y = rect.top + rect.height / 2;
      path.setAttribute('d', `M${x},${y} C${x - 90},${y} ${endpoint.x + 90},${endpoint.y} ${endpoint.x},${endpoint.y}`);
    } else path.setAttribute('d', '');
  }; tick();
  return { select, destroy: () => { events.abort(); cancelAnimationFrame(frame); svg.remove(); } };
}
