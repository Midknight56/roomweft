import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { DesignView, ReceiptView } from '../shared/api-types';
import { footprintBounds, type FitReport, type Footprint } from '../shared/fit';
import { ROOM, DOOR, STYLES, WINDOW } from '../shared/room';
import { fitBadge, layoutOf, projectPoint } from './helpers';
import { furniture, dispose, tag, setTagMode } from './meshes';
import { texture } from './textures';
import { theme } from './theme';
import { roomDoor, doorArc, setDoorMode } from './door';
import { FrameReadiness } from './return-state';
import { planFrustum } from './plan-framing';
import { floorOutline } from './floor-status';
import { pathDots, walkwayStripSegments } from './walkway-strip';

export type Mode = 'Overview' | 'Plan' | 'Walk';
export class RoomScene {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly overview = new THREE.PerspectiveCamera(45, 1, 1, 3000);
  readonly plan = new THREE.OrthographicCamera(-250, 250, 210, -210, 1, 2000);
  readonly walk = new THREE.PerspectiveCamera(65, 1, 1, 2000);
  readonly orbit: OrbitControls;
  readonly objects = new Map<string, THREE.Group>();
  readonly ray = new THREE.Raycaster();
  readonly shell = new THREE.Group(); readonly pieces = new THREE.Group(); readonly regions = new THREE.Group();
  layout: Footprint[] = []; mode: Mode = 'Overview'; design: DesignView | null = null;
  private readonly readiness = new FrameReadiness(ready => { window.__roomweftReady = ready; });
  private suspended = false;
  private active: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private transition: { start: number; position: THREE.Vector3; quaternion: THREE.Quaternion } | null = null;
  private frame = 0; private lastTime = 0; private selected: string | null = null;
  private observer: ResizeObserver;
  onFrame: ((dt: number) => void) | null = null;
  constructor(readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.tabIndex = 0; this.renderer.domElement.setAttribute('aria-label', 'Room view. Use Plan to move furniture or Walk to explore.'); host.prepend(this.renderer.domElement);
    this.scene.background = new THREE.Color(theme.paper); this.scene.add(this.shell, this.pieces, this.regions);
    this.overview.position.set(560, 480, -290); this.overview.lookAt(190, 95, 160);
    this.plan.position.set(190, 850, 160); this.plan.up.set(0, 0, 1); this.plan.lookAt(190, 0, 160);
    this.walk.position.set(250, 160, 55); this.walk.rotation.order = 'YXZ'; this.walk.lookAt(190, 160, 260);
    this.active = this.overview;
    this.orbit = new OrbitControls(this.overview, this.renderer.domElement); this.orbit.target.set(190, 95, 160); this.orbit.enableDamping = true; this.orbit.autoRotate = true; this.orbit.autoRotateSpeed = .35; this.orbit.maxPolarAngle = Math.PI / 2 - .03; this.orbit.minDistance = 330; this.orbit.maxDistance = 1100;
    this.orbit.addEventListener('start', () => { this.orbit.autoRotate = false; });
    this.host.addEventListener('pointerdown', this.stopTurn);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(host); this.resize(); this.room(STYLES[0]);
    const tick = (time: number): void => {
      this.frame = requestAnimationFrame(tick); const dt = Math.min((time - this.lastTime) / 1000, .05); this.lastTime = time;
      if (this.mode === 'Overview' && !this.transition) this.orbit.update(); this.onFrame?.(dt);
      if (this.transition) {
        const camera = this.camera; const t = Math.min((time - this.transition.start) / 600, 1); const ease = t * t * (3 - 2 * t);
        this.active.position.lerpVectors(this.transition.position, camera.position, ease); this.active.quaternion.slerpQuaternions(this.transition.quaternion, camera.quaternion, ease);
        if (t === 1) { this.active = camera; this.transition = null; }
      }
      this.renderer.render(this.scene, this.active);
      if (!this.suspended) this.readiness.drawn();
    }; this.frame = requestAnimationFrame(tick);
  }
  private stopTurn = (): void => { this.orbit.autoRotate = false; };
  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera { return this.mode === 'Plan' ? this.plan : this.mode === 'Walk' ? this.walk : this.overview; }
  setMode(mode: Mode): void {
    if (mode === this.mode) return;
    // Mirror the top view so east is right while north stays at the top.
    this.renderer.domElement.style.transform = mode === 'Plan' ? 'scaleX(-1)' : '';
    const previous = this.active; this.mode = mode; this.orbit.enabled = mode === 'Overview';
    const tween = new THREE.PerspectiveCamera(45, this.overview.aspect, 1, 3000); tween.position.copy(previous.position); tween.quaternion.copy(previous.quaternion); this.active = tween;
    this.transition = { start: performance.now(), position: previous.position.clone(), quaternion: previous.quaternion.clone() };
    if (mode === 'Plan') { this.active = this.plan; this.transition = null; }
    this.shell.traverse(child => { if (child.userData.ceiling) child.visible = mode === 'Walk'; });
    setDoorMode(this.shell, mode);
    setTagMode(this.pieces, mode);
    this.setWalkwayMode(mode);
  }
  resize(): void {
    const width = this.host.clientWidth; const height = this.host.clientHeight;
    this.renderer.setSize(width, height); this.overview.aspect = this.walk.aspect = width / Math.max(height, 1); this.overview.updateProjectionMatrix(); this.walk.updateProjectionMatrix();
    const host = this.host.getBoundingClientRect();
    const modes = this.host.querySelector('.view-modes')?.getBoundingClientRect();
    const tools = this.host.querySelector<HTMLElement>('.plan-tools');
    const top = modes ? modes.bottom - host.top - this.host.clientTop + 8 : 8;
    const bottom = tools && !tools.hidden ? tools.getBoundingClientRect().top - host.top - this.host.clientTop - 8 : height - 8;
    Object.assign(this.plan, planFrustum(width, height, { left: 8, right: width - 8, top, bottom }));
    this.plan.position.set(ROOM.width / 2, 850, ROOM.depth / 2); this.plan.lookAt(ROOM.width / 2, 0, ROOM.depth / 2); this.plan.updateProjectionMatrix();
  }
  room(style: typeof STYLES[number]): void {
    dispose(this.shell); this.shell.clear();
    const floorMap = texture('wood', style.palette.floor); const wallMap = texture('plaster', style.palette.wall);
    const wood = new THREE.MeshStandardMaterial({ map: floorMap, roughness: .8 }); const plaster = new THREE.MeshStandardMaterial({ map: wallMap, side: THREE.DoubleSide, roughness: 1 });
    const trim = new THREE.MeshStandardMaterial({ color: style.palette.trim });
    const addBox = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); mesh.position.set(x, y, z); mesh.receiveShadow = true; mesh.castShadow = true; this.shell.add(mesh); return mesh;
    };
    addBox(380, 4, 320, 190, -2, 160, wood);
    // The front and east walls are open in the dollhouse view.
    addBox(4, 260, 320, -2, 130, 160, plaster);
    addBox(140, 260, 4, 70, 130, 322, plaster); addBox(120, 90, 4, 200, 45, 322, plaster); addBox(120, 40, 4, 200, 240, 322, plaster); addBox(120, 260, 4, 320, 130, 322, plaster);
    for (const [w, h, d, x, y, z] of [[220, 250, 4, 110, 135, -2], [80, 250, 4, 340, 135, -2], [80, 51, 4, 260, 234.5, -2], [4, 260, 320, 382, 130, 160], [380, 4, 320, 190, 262, 160]]) {
      const wall = addBox(w, h, d, x, y, z, plaster); wall.userData.ceiling = true; wall.visible = this.mode === 'Walk';
    }
    addBox(380, 8, 3, 190, 4, 318, trim); addBox(3, 8, 320, 2, 4, 160, trim);
    const sky = new THREE.MeshBasicMaterial({ color: style.light.kind === 'evening' ? '#213961' : '#B8D9E8' }); addBox(120, 130, 2, 200, 155, 323, sky);
    for (const x of [140, 200, 260]) addBox(4, 134, 8, x, 155, 319, trim);
    for (const y of [90, 220]) addBox(124, 4, 8, 200, y, 319, trim);
    addBox(220, 10, 4, 110, 5, -2, plaster); addBox(80, 10, 4, 340, 5, -2, plaster);
    const door = roomDoor(trim); setDoorMode(door, this.mode); this.shell.add(door);
    this.shell.add(new THREE.HemisphereLight('#FFF2D8', '#6B493B', style.light.kind === 'evening' ? .45 : 1.7));
    const sun = new THREE.DirectionalLight(style.light.colour, style.light.intensity * 2.3); sun.position.set(170, 330, 430); sun.target.position.set(190, 0, 130); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -400, right: 400, top: 400, bottom: -400, far: 1200 }); sun.shadow.bias = -.0005; sun.shadow.normalBias = .6; this.shell.add(sun, sun.target);
    for (const [x, y, z] of [[310, 105, 285], [20, 150, 250]]) { const lamp = new THREE.PointLight('#FFCB8A', style.light.kind === 'evening' ? 15000 : 2500, 300, 2); lamp.position.set(x, y, z); this.shell.add(lamp); }
  }
  loading(): void { this.suspended = true; window.__roomweftReady = false; }
  resume(): void { this.suspended = false; }
  update(design: DesignView, receipt: ReceiptView | null): void {
    const version = this.readiness.loading();
    const models: Promise<void>[] = [];
    if (this.design?.style !== design.style) this.room(STYLES.find(style => style.id === design.style) ?? STYLES[0]);
    this.design = design; this.layout = layoutOf(design); dispose(this.pieces); this.pieces.clear(); this.objects.clear();
    for (const item of this.layout) {
      const slot = design.slots.find(slot => slot.slot === item.id); const colour = slot?.pick?.colors[0] ?? (item.source === 'owned' ? '#A67E56' : theme.thread);
      let loaded = (): void => {}; models.push(new Promise<void>(resolve => { loaded = resolve; }));
      const root = furniture(item, /^#[\da-f]{6}$/i.test(colour) ? colour : theme.thread, loaded);
      if (receipt?.plan.some(line => line.roomObjectId === item.id && line.status === 'returned')) { root.traverse(child => { if (child instanceof THREE.Mesh) { const material = (child.material as THREE.MeshStandardMaterial).clone(); material.transparent = true; material.opacity = .3; child.material = material; } }); const returned = tag('Returned', theme.thread); returned.position.y = item.h + 34; root.add(returned); root.userData.returned = true; }
      this.objects.set(item.id, root); this.pieces.add(root);
    }
    setTagMode(this.pieces, this.mode);
    this.showFit(design.fit); this.highlight(this.selected);
    void Promise.all(models).then(() => this.readiness.loadedDesign(version));
  }
  showFit(fit: FitReport): void {
    dispose(this.regions); this.regions.clear();
    this.regions.add(doorArc(fit.doorSwing.length ? theme.alarm : theme.amber, fit.doorSwing.length > 0));
    const cells = fit.walkway.pinch;
    if (cells.length) { const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(5, 5), new THREE.MeshBasicMaterial({ color: theme.alarm, transparent: true, opacity: .45, side: THREE.DoubleSide }), cells.length); const dummy = new THREE.Object3D(); cells.forEach((cell, index) => { dummy.position.set(cell.x, 1.5, cell.z); dummy.rotation.x = -Math.PI / 2; dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix); }); mesh.renderOrder = 3; this.regions.add(mesh); }
    for (const target of fit.walkway.targets ?? []) {
      const path = target.path ?? [];
      if (path.length >= 2) {
        const dots = pathDots(path, 12);
        if (dots.length > 0) {
          const dotGeom = new THREE.CircleGeometry(3, 24);
          const dotMat = new THREE.MeshBasicMaterial({ color: target.reachable ? theme.ink : theme.alarm, depthTest: false, side: THREE.DoubleSide });
          const dotMesh = new THREE.InstancedMesh(dotGeom, dotMat, dots.length);
          const dummy = new THREE.Object3D();
          dots.forEach((dot, index) => {
            dummy.position.set(dot.x, 2, dot.z);
            dummy.rotation.x = -Math.PI / 2;
            dummy.updateMatrix();
            dotMesh.setMatrixAt(index, dummy.matrix);
          });
          dotMesh.instanceMatrix.needsUpdate = true;
          dotMesh.renderOrder = 4;
          dotMesh.userData.walkwayPlan = true;
          this.regions.add(dotMesh);
        }
        const stripColor = target.reachable ? '#FFF4DC' : theme.alarm;
        const stripOpacity = target.reachable ? 0.42 : 0.25;
        for (const segment of walkwayStripSegments(path, 76)) {
          const strip = new THREE.Mesh(new THREE.PlaneGeometry(segment.width, segment.depth),
            new THREE.MeshBasicMaterial({ color: stripColor, transparent: true, opacity: stripOpacity, depthWrite: false, side: THREE.DoubleSide }));
          strip.rotation.x = -Math.PI / 2; strip.position.set(segment.x, 1.3, segment.z);
          strip.renderOrder = 1; strip.userData.walkwayFloor = true;
          this.regions.add(strip);
        }
      }
    }
    for (const item of this.layout) {
      const badge = fitBadge(fit, item.id);
      const returned = this.objects.get(item.id)?.userData.returned === true;
      const colour = returned ? theme.thread : theme[badge.tone];
      this.regions.add(floorOutline(item, colour, returned || badge.tone !== 'moss'));
    }
    this.setWalkwayMode(this.mode);
  }
  private setWalkwayMode(mode: Mode): void {
    this.regions.traverse(child => {
      if (child.userData.walkwayPlan) child.visible = mode === 'Plan';
      if (child.userData.walkwayFloor) child.visible = mode !== 'Plan';
    });
  }
  highlight(id: string | null): void {
    this.selected = id;
    this.objects.forEach((root, key) => root.traverse(child => { if (child instanceof THREE.Mesh) { const materials = Array.isArray(child.material) ? child.material : [child.material]; materials.forEach(material => { if (material instanceof THREE.MeshStandardMaterial) { material.emissive.set(key === id ? theme.thread : '#000000'); material.emissiveIntensity = key === id ? .28 : 0; } }); } }));
  }
  project(id: string): { x: number; y: number } | null {
    const item = this.layout.find(item => item.id === id); if (!item) return null;
    const point = new THREE.Vector3(item.x, item.h / 2, item.z).project(this.active);
    if (this.mode === 'Plan') point.x *= -1;
    return projectPoint(point, this.renderer.domElement.getBoundingClientRect());
  }
  point(event: PointerEvent): void { const rect = this.renderer.domElement.getBoundingClientRect(); this.ray.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width * 2 - 1) * (this.mode === 'Plan' ? -1 : 1), -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera); }
  hit(event: PointerEvent): string | null { this.point(event);
    if (this.mode === 'Plan') {
      const point = this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),new THREE.Vector3());
      if (!point) return null;
      return [...this.layout].sort((a,b) => Number(a.kind === 'rug')-Number(b.kind === 'rug')).find(item => {
        const bounds = footprintBounds(item);
        return point.x >= bounds.minX && point.x <= bounds.maxX && point.z >= bounds.minZ && point.z <= bounds.maxZ;
      })?.id ?? null;
    }
    const hits = this.ray.intersectObjects(this.pieces.children, true); for (const hit of hits) { let root: THREE.Object3D | null = hit.object; while (root) { if (typeof root.userData.itemId === 'string') return root.userData.itemId; root = root.parent; } } return null; }
  destroy(): void { this.readiness.loading(); cancelAnimationFrame(this.frame); this.observer.disconnect(); this.host.removeEventListener('pointerdown', this.stopTurn); this.orbit.dispose(); dispose(this.scene); this.renderer.dispose(); }
}
