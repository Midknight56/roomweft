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
