import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Footprint } from '../shared/fit';
import { theme } from './theme';

export function tag(text: string, colour: string = theme.ink): THREE.Sprite {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96;
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = theme.panel; ctx.fillRect(0, 0, 512, 96); ctx.fillStyle = colour; ctx.font = 'bold 42px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(text, 256, 62);
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, depthTest: false })); sprite.userData.tag = true; sprite.scale.set(88, 16, 1); sprite.renderOrder = 10; return sprite;
}
export function setTagMode(root: THREE.Object3D, mode: 'Overview' | 'Plan' | 'Walk'): void {
  root.traverse(child => {
    if (!(child instanceof THREE.Sprite) || !child.userData.tag || !child.material.map) return;
    const map = child.material.map;
    map.repeat.x = mode === 'Plan' ? -1 : 1;
    map.offset.x = mode === 'Plan' ? 1 : 0;
  });
}
export function proxy(kind: string, colour: string): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: colour, roughness: .82 });
  const wood = new THREE.MeshStandardMaterial({ color: '#80583B', roughness: .7 });
  const metal = new THREE.MeshStandardMaterial({ color: theme.ink, roughness: .45 });
  function box(w: number, h: number, d: number, x: number, y: number, z: number, material = body): void {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); mesh.position.set(x, y, z); mesh.castShadow = mesh.receiveShadow = true; group.add(mesh);
  }
  function cylinder(r: number, h: number, x: number, y: number, z: number, material = body): void {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24), material); mesh.position.set(x, y, z); mesh.castShadow = mesh.receiveShadow = true; group.add(mesh);
  }
  if (kind === 'rug') { box(1, .025, 1, 0, .015, 0); }
  else if (kind === 'floor-lamp' || kind === 'lamp') { cylinder(.38, .035, 0, .02, 0, metal); cylinder(.025, .85, 0, .45, 0, metal); cylinder(.27, .2, 0, .87, 0); }
  else if (kind === 'bookshelf') {
    box(.06, 1, 1, -.47, .5, 0, wood); box(.06, 1, 1, .47, .5, 0, wood); box(1, 1, .04, 0, .5, -.48, wood);
    for (let level = 0; level < 5; level++) { box(1, .035, 1, 0, level * .23 + .03, 0, wood); for (let n = 0; n < 7; n++) box(.08, .13 + (n % 3) * .02, .65, -.35 + n * .11, level * .23 + .12, .04, new THREE.MeshStandardMaterial({ color: [theme.thread, theme.moss, theme.ink, theme.amber][n % 4] })); }
  } else if (kind === 'plant') { cylinder(.27, .3, 0, .15, 0, wood); for (let n = 0; n < 7; n++) { const leaf = new THREE.Mesh(new THREE.SphereGeometry(.23, 12, 8), new THREE.MeshStandardMaterial({ color: theme.moss })); leaf.scale.set(.5, 1.6, .6); leaf.position.set(Math.sin(n) * .2, .5 + n * .04, Math.cos(n) * .2); group.add(leaf); } }
  else if (kind === 'desk' || kind === 'side-table' || kind === 'table') {
    box(1, .075, 1, 0, .94, 0, wood); for (const x of [-.41, .41]) for (const z of [-.41, .41]) box(.055, .92, .055, x, .46, z, wood);
  } else {
    box(.9, .19, .86, 0, .43, .03); box(.93, .5, .15, 0, .75, -.41);
    if (kind === 'reading-chair' || kind === 'armchair') { box(.14, .28, .9, -.43, .57, 0); box(.14, .28, .9, .43, .57, 0); }
    for (const x of [-.34, .34]) for (const z of [-.32, .32]) box(.065, .34, .065, x, .17, z, wood);
  }
  return group;
}
const loader = new GLTFLoader();
const models = new Map<string, Promise<THREE.Group | null>>();
let availableKinds: Promise<Set<string>> | null = null;
function modelKinds(): Promise<Set<string>> {
  availableKinds ??= fetch('/models/manifest.json').then(response => response.ok ? response.json() as Promise<{ kinds?: unknown }> : { kinds: [] })
    .then(manifest => new Set(Array.isArray(manifest.kinds) ? manifest.kinds.filter((kind): kind is string => typeof kind === 'string') : []))
    .catch(() => new Set<string>());
  return availableKinds;
}
export function furniture(item: Footprint, colour: string, loaded: () => void = () => {}): THREE.Group {
  const root = new THREE.Group(); root.position.set(item.x, 0, item.z); root.rotation.y = item.rot * Math.PI / 180; root.userData.itemId = item.id;
  const visual = proxy(item.kind, colour); visual.scale.set(item.w, item.h, item.d); root.add(visual);
  if (item.nominal) {
    const label = tag('Fit unverified', theme.amber); label.position.y = item.h + 12; root.add(label);
    loaded(); return root;
  }
  const kind = ({ 'reading-chair': 'armchair', 'chair': 'desk-chair', 'floor-lamp': 'floor-lamp', 'lamp': 'floor-lamp', 'table': 'side-table' } as Record<string, string>)[item.kind] ?? item.kind;
  let model = models.get(kind);
  if (!model) { model = modelKinds().then(kinds => kinds.has(kind) ? loader.loadAsync(`/models/${kind}.glb`).then(gltf => gltf.scene).catch(() => null) : null); models.set(kind, model); }
  void model.then(source => {
    if (!source || root.userData.disposed) return;
    const mesh = source.clone(true); const bounds = new THREE.Box3().setFromObject(mesh); const size = bounds.getSize(new THREE.Vector3());
    if (Math.min(size.x, size.y, size.z) <= 0) return;
    mesh.position.sub(bounds.getCenter(new THREE.Vector3())); mesh.position.y += size.y / 2;
    const wrapper = new THREE.Group(); wrapper.add(mesh); wrapper.scale.set(item.w / size.x, item.h / size.y, item.d / size.z);
    mesh.traverse(child => { if (child instanceof THREE.Mesh) {
      child.geometry = child.geometry.clone();
      const cloneMaterial = (material: THREE.Material): THREE.Material => {
        const copy = material.clone();
        // Model texture maps belong to the cache, so each instance keeps its own copy.
        for (const key of Object.keys(copy)) { const value = (copy as unknown as Record<string, unknown>)[key]; if (value instanceof THREE.Texture) (copy as unknown as Record<string, unknown>)[key] = value.clone(); }
        if (root.userData.returned) { copy.transparent = true; copy.opacity = .3; }
        return copy;
      };
      child.material = Array.isArray(child.material) ? child.material.map(cloneMaterial) : cloneMaterial(child.material);
      child.castShadow = child.receiveShadow = true;
    } });
    root.remove(visual); dispose(visual); root.add(wrapper);
  }).finally(loaded);
  if (item.locked) { const lock = padlock(); lock.position.y = item.h + 12; root.add(lock); }
  return root;
}
export function padlock(): THREE.Sprite {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = theme.ink; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(32, 24, 13, Math.PI, 0); ctx.lineTo(45, 34); ctx.stroke();
  ctx.fillStyle = theme.panel; ctx.fillRect(12, 30, 40, 29); ctx.strokeRect(12, 30, 40, 29); ctx.fillStyle = theme.ink; ctx.fillRect(30, 39, 4, 12);
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, depthTest: false })); sprite.name = 'padlock'; sprite.scale.set(12, 12, 1); sprite.renderOrder = 10; return sprite;
}
export function dispose(root: THREE.Object3D): void {
  root.traverse(object => {
    object.userData.disposed = true;
    if (object instanceof THREE.DirectionalLight || object instanceof THREE.PointLight || object instanceof THREE.SpotLight) object.shadow.dispose();
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Sprite) {
      if ('geometry' in object) object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) { for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose(); material.dispose(); }
    }
  });
}
