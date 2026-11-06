import * as THREE from 'three';

export const doorSpec = { x: 220, z: 0, width: 80, height: 205, thickness: 4, angle: 70 } as const;
export function roomDoor(trim: THREE.Material): THREE.Group {
  const root = new THREE.Group();
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, parent = root, material = trim): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); mesh.position.set(x, y, z); mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh;
  };
  // The jambs sit outside the clear opening.
  box(4, 209, 8, 218, 104.5, 0); box(4, 209, 8, 302, 104.5, 0); box(88, 4, 8, 260, 207, 0);
  const hinge = new THREE.Group(); hinge.name = 'door-hinge'; hinge.position.set(doorSpec.x, 0, doorSpec.z); hinge.rotation.y = -THREE.MathUtils.degToRad(doorSpec.angle); root.add(hinge);
  const leaf = box(doorSpec.width, doorSpec.height, doorSpec.thickness, 40, 102.5, 0, hinge); leaf.name = 'door-leaf';
  const brass = new THREE.MeshStandardMaterial({ color: '#B08D45', metalness: .75, roughness: .28 });
  for (const side of [-1, 1]) { box(3, 7, 1, 72, 100, side * 2.5, hinge, brass); box(9, 2, 2, 69, 101, side * 4, hinge, brass); }
  return root;
}

export function doorArc(colour: string): THREE.Line {
  const points = Array.from({ length: 49 }, (_, n) => {
    const angle = n / 48 * THREE.MathUtils.degToRad(doorSpec.angle);
    return new THREE.Vector3(doorSpec.x + Math.cos(angle) * doorSpec.width, 1, Math.sin(angle) * doorSpec.width);
  });
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineDashedMaterial({ color: colour, dashSize: 4, gapSize: 3, transparent: true, opacity: .65 }));
  line.computeLineDistances(); return line;
}
