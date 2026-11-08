/// <reference lib="dom" />
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { roomDoor, doorArc, setDoorMode } from '../../src/client/door';
import { checkoutReturn, FrameReadiness, returnNotice } from '../../src/client/return-state';
import { furniture, padlock, dispose, tag, setTagMode } from '../../src/client/meshes';
import { walkStart, doorLeafDistance } from '../../src/client/walk-start';
import { collides } from '../../src/client/helpers';
import { OWNED_ITEMS, ROOM } from '../../src/shared/room';
import type { Footprint } from '../../src/shared/fit';
import { theme } from '../../src/client/theme';


describe('checkout return', () => {
  it('keeps receipt ids and cleans only return parameters', () => {
    expect(checkoutReturn('https://room.test/?receipt=q%2F1&keep=yes#basket')).toEqual({ receiptId: 'q/1', message: '', cleanUrl: '/?receipt=q%2F1&keep=yes#basket', present: true });
    expect(checkoutReturn('https://room.test/').present).toBe(false);
  });
  it.each(['cancelled', 'declined', 'changed', 'stale'])('explains %s returns', state => {
    expect(checkoutReturn(`https://room.test/?checkout=${state}`).message).not.toBe('');
    expect(checkoutReturn(`https://room.test/?checkout=${state}&message=Review%20this`).message).toBe('Review this');
    const message = checkoutReturn(`https://room.test/?checkout=${state}`).message;
    expect(returnNotice(message, 'The old swap note.')).toBe(message);
  });
  it('keeps normal room notices when there is no checkout message', () => {
    expect(returnNotice('', 'The current swap note.')).toBe('The current swap note.');
  });
});

describe('walk start', () => {
  const owned: Footprint[] = OWNED_ITEMS.map(item => ({ ...item, source: 'owned', dims: 'verified' }));
  const chair: Footprint = { id: 'reading-chair', label: 'Reading chair', kind: 'reading-chair', x: 335, z: 65, w: 60, d: 60, h: 80, rot: 270, locked: false, source: 'slot', dims: 'verified' };
  it.each([owned, [...owned, chair], [...owned, { ...chair, x: 190, z: 55 }]])('chooses a free interior point away from the leaf', (...layout) => {
    const start = walkStart(layout)!;
    expect(start).not.toBeNull();
    expect(start.x).toBeGreaterThan(0); expect(start.x).toBeLessThan(ROOM.width);
    expect(start.z).toBeGreaterThan(0); expect(start.z).toBeLessThan(ROOM.depth);
    // Independently measure against the physical seventy degree leaf segment.
    const edge = { x: 220 + 80 * Math.cos(70 * Math.PI / 180), z: 80 * Math.sin(70 * Math.PI / 180) };
    const t = Math.max(0, Math.min(1, ((start.x - 220) * (edge.x - 220) + start.z * edge.z) / 6400));
    expect(Math.hypot(start.x - 220 - t * (edge.x - 220), start.z - t * edge.z)).toBeGreaterThanOrEqual(45);
    expect(collides(start, layout)).toBe(false);
  });
  it('rejects the old start beside the door and handles a full room', () => {
    expect(doorLeafDistance({ x: 250, z: 55 })).toBeLessThan(45);
    expect(walkStart([{ ...chair, x: 190, z: 160, w: 380, d: 320, rot: 0 }])).toBeNull();
  });
});

it('mirrors only tag textures in Plan and restores them across modes and updates', () => {
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, fillText() {} }) }) });
  try {
    const root = new THREE.Group(), label = tag('Fit unverified');
    const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.Texture() }));
    root.add(label, icon);
    for (const mode of ['Plan', 'Plan', 'Overview', 'Walk', 'Plan'] as const) {
      setTagMode(root, mode);
      expect(label.material.map!.repeat.x).toBe(mode === 'Plan' ? -1 : 1);
      expect(label.material.map!.offset.x).toBe(mode === 'Plan' ? 1 : 0);
      expect(icon.material.map!.repeat.x).toBe(1);
    }
    const returned = tag('Returned'); root.add(returned); setTagMode(root, 'Plan');
    expect(returned.material.map!.repeat.x).toBe(-1);
    dispose(root);
  } finally { vi.unstubAllGlobals(); }
});
describe('draw readiness', () => {
  it('waits for loading and a drawn frame and ignores an older design', () => {
    let ready = true; const state = new FrameReadiness(value => { ready = value; });
    expect(ready).toBe(false); const first = state.loading(); state.drawn(); expect(ready).toBe(false);
    state.loadedDesign(first); expect(ready).toBe(false); state.drawn(); expect(ready).toBe(true);
    const second = state.loading(); expect(ready).toBe(false); state.loadedDesign(first); state.drawn(); expect(ready).toBe(false);
    state.loadedDesign(second); state.drawn(); expect(ready).toBe(true);
  });
});
describe('door geometry', () => {
  it('keeps a nominal proxy at its anchor with an amber label and no model load',()=>{
    const fillText=vi.fn(), loaded=vi.fn();
    const ctx={fillStyle:'',font:'',textAlign:'',fillRect() {},fillText};
    vi.stubGlobal('document',{createElement:()=>({width:0,height:0,getContext:()=>ctx})});
    try {
      const item:Footprint={id:'reading-chair',label:'Reading chair',kind:'reading-chair',x:341,z:39,rot:270,w:70,d:70,h:80,locked:false,source:'slot',dims:'unverified',nominal:true};
      const root=furniture(item,'#ffffff',loaded);
      expect(root.position.toArray()).toEqual([341,0,39]);
      expect(root.children[0].scale.toArray()).toEqual([70,80,70]);
      expect(root.children[1]).toBeInstanceOf(THREE.Sprite);
      expect(fillText).toHaveBeenCalledWith('Fit unverified',256,62);
      expect(ctx.fillStyle).toBe(theme.amber);
      expect(loaded).toHaveBeenCalledOnce();
      dispose(root);
    } finally {vi.unstubAllGlobals();}
  });
  it('has a full size trim leaf hinged into the room with a brass handle and frame', () => {
    const trim = new THREE.MeshStandardMaterial({ color: '#ffffff' }); const door = roomDoor(trim);
    const leaf = door.getObjectByName('door-leaf') as THREE.Mesh<THREE.BoxGeometry>;
    const hinge = door.getObjectByName('door-hinge')!;
    expect(leaf.geometry.parameters).toMatchObject({ width: 80, height: 205, depth: 4 }); expect(leaf.material).not.toBe(trim);
    const material = leaf.material as THREE.MeshStandardMaterial;
    expect(material.transparent).toBe(true); expect(material.opacity).toBeCloseTo(.35); expect(material.depthWrite).toBe(false);
    setDoorMode(door, 'Walk'); expect(material.transparent).toBe(false); expect(material.opacity).toBe(1); expect(material.depthWrite).toBe(true);
    setDoorMode(door, 'Overview'); expect(material.transparent).toBe(true); expect(material.opacity).toBeCloseTo(.35);
    expect(hinge.position.toArray()).toEqual([220, 0, 0]); expect(hinge.rotation.y).toBeCloseTo(-70 * Math.PI / 180);
    door.updateMatrixWorld(true); const edge = hinge.localToWorld(new THREE.Vector3(80, 0, 0)); expect(edge.x).toBeCloseTo(247.36, 2); expect(edge.z).toBeCloseTo(75.18, 2);
    expect(door.children).toHaveLength(4); expect(hinge.children).toHaveLength(5);
  });
  it('draws a dashed floor arc around the same hinge over seventy degrees', () => {
    const arc = doorArc('#000000', false); const line = arc.getObjectByName('door-swing-outline') as THREE.Line; const points = line.geometry.getAttribute('position');
    expect(line.material).toBeInstanceOf(THREE.LineDashedMaterial); expect(line.geometry.getAttribute('lineDistance')).toBeDefined();
    expect(arc.getObjectByName('door-swing-warning')).toBeUndefined(); expect((line.material as THREE.LineDashedMaterial).opacity).toBeCloseTo(.22);
    expect([points.getX(0), points.getY(0), points.getZ(0)]).toEqual([300, 1, 0]);
    expect(points.getX(48)).toBeCloseTo(247.36, 2); expect(points.getZ(48)).toBeCloseTo(75.18, 2);
    const warning = doorArc('#ff0000', true); expect(warning.getObjectByName('door-swing-warning')).toBeInstanceOf(THREE.Mesh);
  });
});
it('uses one small text free padlock sprite', () => {
  const fillText = vi.fn();
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ beginPath() {}, arc() {}, lineTo() {}, stroke() {}, fillRect() {}, strokeRect() {}, fillText }) }) });
  try { const icon = padlock(); expect(icon).toBeInstanceOf(THREE.Sprite); expect(icon.scale.toArray()).toEqual([12, 12, 1]); expect(icon.name).toBe('padlock'); expect(fillText).not.toHaveBeenCalled(); dispose(icon); }
  finally { vi.unstubAllGlobals(); }
});

it('disposes walkway dots and strip meshes with regions', () => {
  const root = new THREE.Group();
  const dots = new THREE.InstancedMesh(new THREE.CircleGeometry(3, 24), new THREE.MeshBasicMaterial({ color: theme.ink }), 3);
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(76, 50), new THREE.MeshBasicMaterial({ color: theme.thread }));
  root.add(dots, strip);
  dispose(root);
  expect(root.userData.disposed).toBe(true);
  expect(dots.userData.disposed).toBe(true);
  expect(strip.userData.disposed).toBe(true);
});
