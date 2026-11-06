/// <reference lib="dom" />
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { roomDoor, doorArc } from '../../src/client/door';
import { checkoutReturn, FrameReadiness } from '../../src/client/return-state';
import { furniture, padlock, dispose } from '../../src/client/meshes';
import type { Footprint } from '../../src/shared/fit';
import { theme } from '../../src/client/theme';


describe('checkout return', () => {
  it('keeps receipt ids and cleans only return parameters', () => {
    expect(checkoutReturn('https://room.test/?receipt=q%2F1&keep=yes#basket')).toEqual({ receiptId: 'q/1', message: '', cleanUrl: '/?keep=yes#basket', present: true });
    expect(checkoutReturn('https://room.test/').present).toBe(false);
  });
  it.each(['cancelled', 'declined', 'changed', 'stale'])('explains %s returns', state => {
    expect(checkoutReturn(`https://room.test/?checkout=${state}`).message).not.toBe('');
    expect(checkoutReturn(`https://room.test/?checkout=${state}&message=Review%20this`).message).toBe('Review this');
  });
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
    expect(leaf.geometry.parameters).toMatchObject({ width: 80, height: 205, depth: 4 }); expect(leaf.material).toBe(trim);
    expect(hinge.position.toArray()).toEqual([220, 0, 0]); expect(hinge.rotation.y).toBeCloseTo(-70 * Math.PI / 180);
    door.updateMatrixWorld(true); const edge = hinge.localToWorld(new THREE.Vector3(80, 0, 0)); expect(edge.x).toBeCloseTo(247.36, 2); expect(edge.z).toBeCloseTo(75.18, 2);
    expect(door.children).toHaveLength(4); expect(hinge.children).toHaveLength(5);
  });
  it('draws a dashed floor arc around the same hinge over seventy degrees', () => {
    const arc = doorArc('#000000'); const points = arc.geometry.getAttribute('position');
    expect(arc.material).toBeInstanceOf(THREE.LineDashedMaterial); expect(arc.geometry.getAttribute('lineDistance')).toBeDefined();
    expect([points.getX(0), points.getY(0), points.getZ(0)]).toEqual([300, 1, 0]);
    expect(points.getX(48)).toBeCloseTo(247.36, 2); expect(points.getZ(48)).toBeCloseTo(75.18, 2);
  });
});
it('uses one small text free padlock sprite', () => {
  const fillText = vi.fn();
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ beginPath() {}, arc() {}, lineTo() {}, stroke() {}, fillRect() {}, strokeRect() {}, fillText }) }) });
  try { const icon = padlock(); expect(icon).toBeInstanceOf(THREE.Sprite); expect(icon.scale.toArray()).toEqual([12, 12, 1]); expect(icon.name).toBe('padlock'); expect(fillText).not.toHaveBeenCalled(); dispose(icon); }
  finally { vi.unstubAllGlobals(); }
});
