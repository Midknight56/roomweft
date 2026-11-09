import type { RoomScene } from './scene';
import { theme } from './theme';
import { missingSizeText } from './helpers';
import { threadVisible } from './thread-visible';

export { threadVisible, type Point2D, type RectLike, type ViewportLike } from './thread-visible';

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
    frame = requestAnimationFrame(tick);
    const endpoint = selected ? view.project(selected) : null;
    const item = view.design?.slots.find(slot => slot.slot === selected);
    const owned = view.layout.find(item => item.id === selected);
    const hostRect = view.host.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };

    if (anchor?.isConnected) {
      const rect = anchor.getBoundingClientRect();
      const start = { x: rect.left + 9, y: rect.top + rect.height / 2 };
      const visible = !!selected && threadVisible(endpoint, hostRect, start, viewport);
      tooltip.hidden = !visible;
      if (visible && endpoint) {
        tooltip.textContent = `${item?.pick?.title ?? owned?.label ?? ''}\nVisual approximation\n${item?.pick && !item.pick.dims ? `${missingSizeText(item.pick)}, fit unverified` : 'Size from the listing'}`;
        if (!item) tooltip.textContent = `${owned?.label ?? ''}\nYour own furniture\n${owned?.locked ? 'Locked' : 'Movable'}`;
        tooltip.style.left = `${Math.max(8, Math.min(hostRect.width - 220, endpoint.x - hostRect.left + 12))}px`;
        tooltip.style.top = `${Math.max(70, Math.min(hostRect.height - 100, endpoint.y - hostRect.top - 50))}px`;
        path.setAttribute('d', `M${start.x},${start.y} C${start.x - 90},${start.y} ${endpoint.x + 90},${endpoint.y} ${endpoint.x},${endpoint.y}`);
      } else {
        path.setAttribute('d', '');
      }
    } else {
      path.setAttribute('d', '');
      const hostRight = hostRect.right ?? (hostRect.left + hostRect.width);
      const hostBottom = hostRect.bottom ?? (hostRect.top + hostRect.height);
      const insideHost = endpoint && endpoint.x >= hostRect.left && endpoint.x <= hostRight && endpoint.y >= hostRect.top && endpoint.y <= hostBottom;
      const insideWindow = endpoint && endpoint.x >= 0 && endpoint.x <= viewport.width && endpoint.y >= 0 && endpoint.y <= viewport.height;
      const visible = !!selected && !!insideHost && !!insideWindow;
      tooltip.hidden = !visible;
      if (visible && endpoint) {
        tooltip.textContent = `${item?.pick?.title ?? owned?.label ?? ''}\nVisual approximation\n${item?.pick && !item.pick.dims ? `${missingSizeText(item.pick)}, fit unverified` : 'Size from the listing'}`;
        if (!item) tooltip.textContent = `${owned?.label ?? ''}\nYour own furniture\n${owned?.locked ? 'Locked' : 'Movable'}`;
        tooltip.style.left = `${Math.max(8, Math.min(hostRect.width - 220, endpoint.x - hostRect.left + 12))}px`;
        tooltip.style.top = `${Math.max(70, Math.min(hostRect.height - 100, endpoint.y - hostRect.top - 50))}px`;
      }
    }
  }; tick();
  return { select, destroy: () => { events.abort(); cancelAnimationFrame(frame); svg.remove(); } };
}
