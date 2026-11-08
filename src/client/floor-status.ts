import * as THREE from 'three';
import type { Footprint } from '../shared/fit';

export function floorOutline(item: Footprint, colour: string, emphasized: boolean): THREE.Group {
  const root = new THREE.Group(); root.name = `floor-${item.id}`;
  const turned = item.rot === 90 || item.rot === 270;
  const w = (turned ? item.d : item.w) / 2;
  const d = (turned ? item.w : item.d) / 2;
  const points = [[-w, -d], [w, -d], [w, d], [-w, d], [-w, -d]]
    .map(([x, z]) => new THREE.Vector3(item.x + x, 2.5, item.z + z));
  const material = emphasized ? new THREE.LineDashedMaterial({ color: colour, dashSize: 8, gapSize: 4, depthTest: false })
    : new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: .35 });
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
  line.computeLineDistances(); line.renderOrder = emphasized ? 5 : 2; root.add(line);
  if (emphasized) {
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(w * 2, d * 2),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: .14, depthWrite: false, side: THREE.DoubleSide }));
    fill.rotation.x = -Math.PI / 2; fill.position.set(item.x, 2, item.z); fill.renderOrder = 2; root.add(fill);
  }
  return root;
}
