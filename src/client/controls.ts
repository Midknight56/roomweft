import * as THREE from 'three';
import { evaluateDesignFit, footprintBounds, moveItem } from '../shared/fit';
import type { Placement } from '../shared/api-types';
import { roomModel } from './room-model';
import { collides, isDesktopWidth, layoutOf, rotate, snap } from './helpers';
import type { RoomScene, Mode } from './scene';
import { walkStart } from './walk-start';

export function controls(view: RoomScene, move: (id: string, placement: Placement) => Promise<void>, select: (id: string | null) => void): { mode: (mode: Mode) => void; rotate: () => void; destroy: () => void } {
  const canvas = view.renderer.domElement; const keys = new Set<string>(); const events = new AbortController(); const signal = events.signal;
  const planTools = document.createElement('div'); planTools.className = 'plan-tools'; planTools.hidden = true;
  const picker = document.createElement('select'); picker.setAttribute('aria-label', 'Select movable furniture');
  picker.addEventListener('change', () => { selection = picker.value || null; select(selection); }, { signal });
  const buttons = (['Move west', 'Move east', 'Move north', 'Move south'] as const).map((label, index) => {
    const [x, z] = [[-5, 0], [5, 0], [0, 5], [0, -5]][index];
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', () => { const item = view.layout.find(item => item.id === selection); if (item && !item.locked) void move(item.id, { x: snap(item.x + x), z: snap(item.z + z), rot: item.rot }); }, { signal });
    return button;
  });
  const details = document.createElement('details'); details.className = 'plan-details';
  const summary = document.createElement('summary'); summary.textContent = 'Keyboard';
  const row = document.createElement('div'); row.className = 'plan-tools-row';
  details.append(summary, row);
  details.addEventListener('toggle', () => { view.resize(); syncOverlay(); }, { signal });
  const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 700px)') : null;
  function updateLayout(): void {
    const isDesktop = media ? media.matches : isDesktopWidth(window.innerWidth);
    if (isDesktop) {
      row.append(picker, ...buttons);
      if (!planTools.contains(details)) {
        details.open = false;
        planTools.replaceChildren(details);
      }
    } else {
      details.remove();
      planTools.replaceChildren(picker, ...buttons);
    }
  }
  updateLayout();
  media?.addEventListener('change', () => { updateLayout(); view.resize(); syncOverlay(); }, { signal });
  window.addEventListener('resize', updateLayout, { signal });
  view.host.append(planTools);
  const framingObserver = new ResizeObserver(() => { view.resize(); syncOverlay(); });
  framingObserver.observe(planTools);
  const modes = view.host.querySelector('.view-modes'); if (modes) framingObserver.observe(modes);
  const overlay = document.createElement('div'); overlay.dataset.testid = 'plan-floor'; overlay.hidden = true;
  overlay.style.cssText = 'position:absolute;pointer-events:none;'; view.host.append(overlay);
  const targets = new Map<string, HTMLButtonElement>();
  let keyTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: { id: string; placement: Placement } | null = null;
  function flushKeys(): void {
    clearTimeout(keyTimer);
    const request = pending; pending = null;
    if (request) void move(request.id, request.placement).finally(() => { if (view.design) { view.layout = layoutOf(view.design); preview(); } });
  }
  function syncOverlay(): void {
    overlay.hidden = view.mode !== 'Plan'; if (overlay.hidden) return;
    view.plan.updateMatrixWorld();
    const rect = canvas.getBoundingClientRect(); const host = view.host.getBoundingClientRect();
    const northWest = new THREE.Vector3(0,0,roomModel().room.depth).project(view.plan);
    const southEast = new THREE.Vector3(roomModel().room.width,0,0).project(view.plan);
    northWest.x *= -1; southEast.x *= -1;
    const left = (northWest.x + 1) / 2 * rect.width; const top = (1 - northWest.y) / 2 * rect.height;
    const width = (southEast.x - northWest.x) / 2 * rect.width; const height = (northWest.y - southEast.y) / 2 * rect.height;
    Object.assign(overlay.style, { left: `${rect.left-host.left-view.host.clientLeft+left}px`, top: `${rect.top-host.top-view.host.clientTop+top}px`, width: `${width}px`, height: `${height}px` });
    for (const [id, button] of targets) if (!view.layout.some(item => item.id === id)) { button.remove(); targets.delete(id); }
    for (const item of view.layout) {
      let button = targets.get(item.id);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.dataset.objectId = item.id;
        button.style.cssText = 'position:absolute;pointer-events:none;background:transparent;color:transparent;border:0;padding:0;min-width:0;min-height:0;';
        button.addEventListener('focus', () => { selection = item.id; select(item.id); }, { signal });
        button.addEventListener('keydown', event => {
          const key = event.key.toLowerCase();
          if (!['arrowleft','arrowright','arrowup','arrowdown','r'].includes(key)) return;
          event.preventDefault(); event.stopPropagation();
          const current = view.layout.find(entry => entry.id === item.id); if (!current) return;
          if (pending && pending.id !== current.id) flushKeys();
          const placement = { x: current.x + (key === 'arrowright' ? 5 : key === 'arrowleft' ? -5 : 0), z: current.z + (key === 'arrowup' ? 5 : key === 'arrowdown' ? -5 : 0), rot: key === 'r' ? rotate(current.rot) : current.rot };
          if (!current.locked && current.movable !== false) {
            const moved = moveItem(view.layout,current.id,placement.x,placement.z,placement.rot);
            if (Array.isArray(moved)) { view.layout = moved; preview(); syncOverlay(); }
          }
          pending = { id: current.id, placement }; clearTimeout(keyTimer); keyTimer = setTimeout(flushKeys,300);
        }, { signal });
        targets.set(item.id,button); overlay.append(button);
      }
      button.setAttribute('aria-label',item.label);
      const bounds = footprintBounds(item);
      Object.assign(button.style, { left: `${bounds.minX / roomModel().room.width * 100}%`, top: `${(1-bounds.maxZ / roomModel().room.depth)*100}%`, width: `${(bounds.maxX-bounds.minX)/roomModel().room.width*100}%`, height: `${(bounds.maxZ-bounds.minZ)/roomModel().room.depth*100}%` });
    }
  }
  let selection: string | null = null; let drag: { id: string; x: number; z: number; pointer: number; original: typeof view.layout; moved: boolean } | null = null;
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); const target = new THREE.Vector3();
  const touches = new Map<number, { x: number; y: number; lastX: number; lastY: number; side: 'move' | 'look' }>();
  let yaw = view.walk.rotation.y; let pitch = 0;
  function preview(): void {
    for (const item of view.layout) { const object = view.objects.get(item.id); if (object) { object.position.set(item.x, 0, item.z); object.rotation.y = item.rot * Math.PI / 180; } }
    if (view.design) {
      view.showFit(evaluateDesignFit(view.layout, {
        prices: Object.fromEntries(view.design.slots.map(slot => [slot.slot, slot.pick?.priceCents ?? 0])),
        budget: view.design.budgetCents,
        unavailable: view.design.slots.filter(slot => slot.unavailable).map(slot => slot.slot),
      }));
    }
  }
  async function drop(): Promise<void> {
    if (!drag) return;
    const current = drag; drag = null; const item = view.layout.find(item => item.id === current.id);
    if (current.moved && item) {
      try { await move(item.id, { x: item.x, z: item.z, rot: item.rot }); }
      finally { if (view.design) { view.layout = layoutOf(view.design); preview(); } }
    } else { view.layout = current.original; preview(); }
  }
  function turn(): void {
    if (view.mode !== 'Plan' || !selection || drag) return;
    const item = view.layout.find(item => item.id === selection); if (!item || item.locked) return;
    void move(item.id, { x: item.x, z: item.z, rot: rotate(item.rot) });
  }
  canvas.addEventListener('pointerdown', event => {
    canvas.focus();
    if (view.mode === 'Walk') {
      if (event.pointerType === 'mouse') { void canvas.requestPointerLock()?.catch(() => { /* Walking with keys remains available if pointer lock is refused. */ }); return; }
      const rect = canvas.getBoundingClientRect(); touches.set(event.pointerId, { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, side: event.clientX < rect.left + rect.width / 2 ? 'move' : 'look' }); canvas.setPointerCapture(event.pointerId); return;
    }
    selection = view.hit(event); select(selection);
    picker.value = selection ?? '';
    if (view.mode !== 'Plan' || !selection) return;
    const item = view.layout.find(item => item.id === selection); if (!item || item.locked) return;
    view.point(event); const point = view.ray.ray.intersectPlane(floor, target); if (!point) return;
    drag = { id: item.id, x: item.x - point.x, z: item.z - point.z, pointer: event.pointerId, original: view.layout.map(item => ({ ...item })), moved: false }; canvas.setPointerCapture(event.pointerId);
  }, { signal });
  canvas.addEventListener('pointermove', event => {
    const touch = touches.get(event.pointerId);
    if (touch) { if (touch.side === 'look') { yaw -= (event.clientX - touch.lastX) * .005; pitch -= (event.clientY - touch.lastY) * .005; } touch.lastX = event.clientX; touch.lastY = event.clientY; return; }
    if (view.mode === 'Walk') return;
    if (!drag) { if (event.pointerType === 'mouse') select(view.hit(event)); return; }
    if (event.pointerId !== drag.pointer) return;
    view.point(event); const point = view.ray.ray.intersectPlane(floor, target); const item = view.layout.find(item => item.id === drag?.id); if (!point || !item) return;
    const result = moveItem(view.layout, item.id, snap(point.x + drag.x), snap(point.z + drag.z), item.rot);
    if (Array.isArray(result)) { view.layout = result; drag.moved = true; preview(); }
  }, { signal });
  canvas.addEventListener('pointerup', event => { touches.delete(event.pointerId); if (drag?.pointer === event.pointerId) void drop(); }, { signal });
  canvas.addEventListener('pointercancel', event => { touches.delete(event.pointerId); if (drag?.pointer === event.pointerId) { view.layout = drag.original; drag = null; preview(); } }, { signal });
  canvas.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse' && !drag && view.mode !== 'Walk') select(null); }, { signal });
  document.addEventListener('mousemove', event => { if (document.pointerLockElement === canvas && view.mode === 'Walk') { yaw -= event.movementX * .002; pitch -= event.movementY * .002; } }, { signal });
  document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement !== canvas && view.mode === 'Walk') setMode('Overview'); }, { signal });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') { touches.clear(); keys.clear(); if (view.mode === 'Walk') setMode('Overview'); }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement || event.target instanceof HTMLSelectElement) return;
    if (event.key.toLowerCase() === 'r') turn();
    if (view.mode === 'Walk' && ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(event.key.toLowerCase())) { event.preventDefault(); keys.add(event.key.toLowerCase()); }
  }, { signal });
  window.addEventListener('keyup', event => keys.delete(event.key.toLowerCase()), { signal });
  window.addEventListener('blur', () => { keys.clear(); touches.clear(); }, { signal });
  view.onFrame = dt => {
    syncOverlay();
    if (view.mode !== 'Walk') return;
    pitch = Math.max(-1.35, Math.min(1.35, pitch)); view.walk.rotation.set(pitch, yaw, 0);
    let x = Number(keys.has('d') || keys.has('arrowright')) - Number(keys.has('a') || keys.has('arrowleft'));
    let z = Number(keys.has('s') || keys.has('arrowdown')) - Number(keys.has('w') || keys.has('arrowup'));
    touches.forEach(touch => { if (touch.side === 'move') { x += Math.max(-1, Math.min(1, (touch.lastX - touch.x) / 55)); z += Math.max(-1, Math.min(1, (touch.lastY - touch.y) / 55)); } });
    const length = Math.max(1, Math.hypot(x, z)); x /= length; z /= length;
    const dx = (x * Math.cos(yaw) + z * Math.sin(yaw)) * 105 * dt; const dz = (-x * Math.sin(yaw) + z * Math.cos(yaw)) * 105 * dt;
    const position = view.walk.position;
    if (!collides({ x: position.x + dx, z: position.z }, view.layout)) position.x += dx;
    if (!collides({ x: position.x, z: position.z + dz }, view.layout)) position.z += dz;
  };
  function setMode(mode: Mode): void {
    if (mode === 'Walk') {
      const start = walkStart(view.layout);
      if (!start) {
        const hint = document.querySelector('#view-hint'); if (hint) hint.textContent = 'Make room to start walking.';
        return;
      }
      view.walk.position.set(start.x, 160, start.z);
      view.walk.lookAt(roomModel().room.width / 2, 95, roomModel().room.depth / 2);
      yaw = view.walk.rotation.y; pitch = view.walk.rotation.x;
    }
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    keys.clear(); touches.clear(); if (drag) { view.layout = drag.original; drag = null; preview(); }
    flushKeys(); view.setMode(mode);
    const rotateButton = document.querySelector<HTMLButtonElement>('#rotate'); if (rotateButton) rotateButton.hidden = mode !== 'Plan';
    const caption = document.querySelector<HTMLElement>('.room-caption'); if (caption) caption.hidden = mode !== 'Overview';
    planTools.hidden = mode !== 'Plan';
    if (mode === 'Plan') {
      details.open = false;
      picker.replaceChildren(new Option('Select an item', ''), ...view.layout.filter(item => !item.locked).map(item => new Option(item.label, item.id)));
      picker.value = selection ?? '';
    }
    view.resize(); syncOverlay();
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
    const hint = document.querySelector('#view-hint'); if (hint) hint.textContent = mode === 'Plan' ? 'Drag an unlocked item. R rotates it. Changes are checked by the server.' : mode === 'Walk' ? 'Click to look. W A S D or arrows to walk. Escape leaves. On touch, left moves and right looks.' : 'Your room, woven around what you own. Drag to orbit.';
  }
  return { mode: setMode, rotate: turn, destroy: () => { clearTimeout(keyTimer); framingObserver.disconnect(); events.abort(); overlay.remove(); planTools.remove(); view.onFrame = null; if (document.pointerLockElement === canvas) document.exitPointerLock(); } };
}
