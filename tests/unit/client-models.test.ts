import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Footprint } from '../../src/shared/fit';

const loadAsync = vi.fn();
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({ GLTFLoader: class { loadAsync = loadAsync; } }));

const item: Footprint = { id: 'chair', label: 'Chair', kind: 'reading-chair', x: 10, z: 20, rot: 0, w: 50, d: 50, h: 70, locked: false, source: 'slot', dims: 'verified' };

describe('model manifest', () => {
  beforeEach(() => { vi.resetModules(); loadAsync.mockReset().mockRejectedValue(new Error('missing fixture')); });

  it('requests no model when the manifest lists none', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ kinds: [] }) }); vi.stubGlobal('fetch', fetcher);
    const { furniture, dispose } = await import('../../src/client/meshes');
    const root: { current: import('three').Group | null } = { current: null }; await new Promise<void>(resolve => { root.current = furniture(item, '#ffffff', resolve); }); if (!root.current) throw new Error('Furniture did not load'); expect(root.current.children).toHaveLength(1); dispose(root.current);
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledWith('/models/manifest.json'); expect(loadAsync).not.toHaveBeenCalled();
  });

  it('requests one listed model kind', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ kinds: ['armchair'] }) }); vi.stubGlobal('fetch', fetcher);
    const { furniture, dispose } = await import('../../src/client/meshes');
    const root: { current: import('three').Group | null } = { current: null }; await new Promise<void>(resolve => { root.current = furniture(item, '#ffffff', resolve); }); if (!root.current) throw new Error('Furniture did not load'); dispose(root.current);
    expect(fetcher).toHaveBeenCalledOnce(); expect(loadAsync).toHaveBeenCalledOnce(); expect(loadAsync).toHaveBeenCalledWith('/models/armchair.glb');
  });
});
import * as THREE from 'three';

describe('room object model selection', () => {
  it.each([
    ['reading-chair', 'chair', '', 'armchair'], ['desk-chair', 'chair', '', 'desk-chair'],
    ['desk', 'table', '', 'desk'], ['bookshelf', 'table', '', 'bookshelf'],
    ['floor-lamp', 'lamp', 'Emry Arc Floor Lamp', 'arc-lamp'],
    ['floor-lamp', 'lamp', 'ARC floor lamp', 'arc-lamp'],
    ['floor-lamp', 'lamp', 'Arcus Floor Lamp', 'floor-lamp'],
    ['floor-lamp', 'lamp', '', 'floor-lamp'],
    ['side-table', 'table', 'Arcus Side Table', 'square-table'],
    ['side-table', 'table', 'Chiro Round Wood Side Table', 'side-table'],
    ['side-table', 'table', 'DRUM table', 'side-table'],
    ['side-table', 'table', 'Pedestal table', 'side-table'],
    ['side-table', 'table', 'Elna Square Side Table', 'square-table'],
    ['side-table', 'table', 'Rounded table', 'square-table'],
    ['rug', 'rug', '', null], ['unknown', 'rug', '', null],
    ['unknown', 'chair', '', 'desk-chair'], ['unknown', 'reading-chair', '', 'armchair'],
    ['unknown', 'lamp', '', 'floor-lamp'], ['unknown', 'floor-lamp', '', 'floor-lamp'],
    ['unknown', 'table', '', 'side-table'], ['unknown', 'plant', '', 'plant'],
  ])('maps %s (%s, %s) to %s', async (id, kind, title, expected) => {
    const { modelKindFor } = await import('../../src/client/meshes');
    expect(modelKindFor(id, kind, title)).toBe(expected);
  });
});

describe('fitted models', () => {
  beforeEach(() => { vi.resetModules(); loadAsync.mockReset(); });
  async function fitted(overrides: Partial<Footprint> = {}, title = 'Emry Arc Floor Lamp', returned = false) {
    const source = new THREE.Group();
    const painted = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), color: '#abcdef' });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(.71, 1.6, .21), painted);
    mesh.position.set(.2, -.8, -.1); source.add(mesh);
    loadAsync.mockResolvedValue({ scene: source });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ kinds: ['arc-lamp', 'armchair', 'side-table', 'square-table', 'desk', 'bookshelf'] }) }));
    const { furniture, dispose } = await import('../../src/client/meshes');
    let root!: THREE.Group;
    await new Promise<void>(resolve => {
      root = furniture({ ...item, id: 'floor-lamp', kind: 'lamp', x: 0, z: 0, w: 32, d: 119, h: 173, ...overrides }, '#123456', resolve, title);
      root.userData.returned = returned;
    });
    return { root, source, painted, dispose, mesh: root.children[0].children[0].children[0] as THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> };
  }
  it('turns an elongated arc lamp before fitting all three dimensions and grounding its top origin', async () => {
    const { root, mesh, dispose } = await fitted();
    expect(mesh.parent!.rotation.y).toBeCloseTo(Math.PI / 2);
    const bounds = new THREE.Box3().setFromObject(root);
    const size = bounds.getSize(new THREE.Vector3());
    for (const [actual, expected] of [[size.x, 32], [size.y, 173], [size.z, 119]]) expect(Math.abs(actual / expected - 1)).toBeLessThan(.05);
    expect(bounds.min.y).toBeCloseTo(0); expect(bounds.getCenter(new THREE.Vector3()).x).toBeCloseTo(0);
    expect(bounds.getCenter(new THREE.Vector3()).z).toBeCloseTo(0); dispose(root);
  });
  it.each(['reading-chair', 'desk', 'bookshelf'])('preserves the front of %s', async id => {
    const { root, mesh, dispose } = await fitted({ id, kind: id });
    expect(mesh.parent!.rotation.y).toBe(0); dispose(root);
  });
  it('keeps an already aligned lamp unchanged', async () => {
    const { root, mesh, dispose } = await fitted({ w: 119, d: 32 });
    expect(mesh.parent!.rotation.y).toBe(0); dispose(root);
  });
  it('does not turn a nearly square footprint', async () => {
    const { root, mesh, dispose } = await fitted({ w: 40, d: 45 });
    expect(mesh.parent!.rotation.y).toBe(0); dispose(root);
  });
  it('turns an elongated table too', async () => {
    const { root, mesh, dispose } = await fitted({ id: 'side-table', kind: 'table' }, 'Round table');
    expect(mesh.parent!.rotation.y).toBeCloseTo(Math.PI / 2); dispose(root);
  });
  it('uses flat listing colour for slots without changing the cached paint', async () => {
    const { root, mesh, painted, dispose } = await fitted();
    expect(mesh.material.map).toBeNull(); expect(mesh.material.color.getHexString()).toBe('123456');
    expect(mesh.material.roughness).toBe(.8); expect(painted.map).not.toBeNull(); dispose(root);
  });
  it('keeps a separate painted texture for owned pieces', async () => {
    const { root, mesh, painted, dispose } = await fitted({ source: 'owned' });
    expect(mesh.material.map).not.toBeNull(); expect(mesh.material.map).not.toBe(painted.map);
    expect(mesh.material.color.getHexString()).toBe('abcdef'); dispose(root);
  });
  it('keeps late loading returned models translucent', async () => {
    const { root, mesh, dispose } = await fitted({}, undefined, true);
    expect(mesh.material.transparent).toBe(true); expect(mesh.material.opacity).toBe(.3); dispose(root);
  });
  it('keeps rugs on the proxy without fetching a model', async () => {
    const { furniture, dispose } = await import('../../src/client/meshes');
    const loaded = vi.fn(); const root = furniture({ ...item, id: 'rug', kind: 'rug' }, '#ffffff', loaded);
    expect(loaded).toHaveBeenCalledOnce(); expect(loadAsync).not.toHaveBeenCalled(); dispose(root);
  });
});
