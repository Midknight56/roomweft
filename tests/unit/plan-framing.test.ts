import { expect, it } from 'vitest';
import * as THREE from 'three';
import { planFrustum } from '../../src/client/plan-framing';

it.each([
  { width: 326, height: 366, free: { left: 8, right: 318, top: 66, bottom: 250 } },
  { width: 356, height: 386, free: { left: 8, right: 348, top: 66, bottom: 270 } },
  { width: 734, height: 469, free: { left: 8, right: 726, top: 66, bottom: 409 } },
  { width: 859, height: 792, free: { left: 8, right: 851, top: 66, bottom: 732 } },
  { width: 500, height: 600, free: { left: 30, right: 470, top: 110, bottom: 330 } },
])('fits walls, centres the floor and preserves hit coordinates in $width pixels', ({ width, height, free }) => {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
  Object.assign(camera, planFrustum(width, height, free));
  camera.position.set(190, 850, 160); camera.up.set(0, 0, 1); camera.lookAt(190, 0, 160);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  const pixel = (x: number, z: number): { x: number; y: number } => {
    const point = new THREE.Vector3(x, 0, z).project(camera);
    return { x: (1 - point.x) / 2 * width, y: (1 - point.y) / 2 * height };
  };
  const nw = pixel(-4, 324), se = pixel(384, -4);
  expect(nw.x).toBeGreaterThanOrEqual(free.left - 1e-6); expect(nw.y).toBeGreaterThanOrEqual(free.top - 1e-6);
  expect(se.x).toBeLessThanOrEqual(free.right + 1e-6); expect(se.y).toBeLessThanOrEqual(free.bottom + 1e-6);
  const centre = pixel(190, 160);
  expect(centre.x).toBeCloseTo((free.left + free.right) / 2); expect(centre.y).toBeCloseTo((free.top + free.bottom) / 2);
  expect(Math.max((se.x - nw.x) / (free.right - free.left), (se.y - nw.y) / (free.bottom - free.top))).toBeCloseTo(1);
  const floorNW = pixel(0, 320), floorSE = pixel(380, 0);
  const item = pixel(55, 255);
  expect(item.x).toBeCloseTo(floorNW.x + 55 / 380 * (floorSE.x - floorNW.x));
  expect(item.y).toBeCloseTo(floorNW.y + (1 - 255 / 320) * (floorSE.y - floorNW.y));
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(-(item.x / width * 2 - 1), 1 - item.y / height * 2), camera);
  const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3())!;
  expect(hit.x).toBeCloseTo(55); expect(hit.z).toBeCloseTo(255);
});
