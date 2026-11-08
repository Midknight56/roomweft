import { expect, it } from 'vitest';
import * as THREE from 'three';
import { floorOutline } from '../../src/client/floor-status';
import { setTagMode } from '../../src/client/meshes';
import { missingSizeText } from '../../src/client/helpers';
import { fixtureCandidate } from './recorded-fixture';
import type { Footprint } from '../../src/shared/fit';

it('keeps status sprites visible only in Plan and mirrors their label texture', () => {
  const root = new THREE.Group();
  for (const name of ['Fit unverified', 'Returned']) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.Texture() }));
    sprite.name = name; sprite.userData.tag = true; root.add(sprite);
  }
  for (const mode of ['Plan', 'Overview', 'Walk', 'Plan'] as const) {
    setTagMode(root, mode);
    root.children.forEach(child => {
      const sprite = child as THREE.Sprite;
      expect(sprite.visible).toBe(mode === 'Plan');
      expect(sprite.material.map?.repeat.x).toBe(mode === 'Plan' ? -1 : 1);
    });
  }
});

it('draws emphasized floor status with a dashed line and faint fill at the rotated footprint', () => {
  const item: Footprint = {id:'rug',label:'Rug',kind:'rug',x:100,z:100,w:60,d:80,h:1,rot:90,locked:false,source:'slot',dims:'unverified'};
  const root = floorOutline(item, '#ff9900', true);
  const line = root.children[0] as THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>;
  expect(line.material).toBeInstanceOf(THREE.LineDashedMaterial);
  expect(line.material.color.getHexString()).toBe('ff9900');
  expect(line.material.depthTest).toBe(false);
  expect(Array.from(line.geometry.getAttribute('position').array).slice(0,3)).toEqual([60,2.5,70]);
  const fill = root.children[1] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  expect(fill.material.opacity).toBe(.14);
  expect(fill.position.y).toBe(2);
  expect(floorOutline(item,'#ffffff',false).children).toHaveLength(1);
});

it('distinguishes absent listing measurements from unusable measurements', () => {
  const candidate = {...fixtureCandidate('unknown'), dims:null};
  expect(missingSizeText(candidate)).toBe('Size not listed');
  expect(missingSizeText({...candidate,hasMeasurements:true})).toBe('Size not usable from the listing');
});
