import * as THREE from 'three';
export function texture(kind: 'wood' | 'plaster', colour: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = colour; ctx.fillRect(0, 0, 256, 256);
  let seed = 29;
  const random = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  if (kind === 'wood') {
    for (let row = 0; row < 8; row++) {
      ctx.fillStyle = '#1F2A4425'; ctx.fillRect(0, row * 32, 256, 1);
      for (let n = 0; n < 34; n++) { ctx.fillStyle = `rgba(60,33,15,${random() * .09})`; ctx.fillRect(random() * 256, row * 32 + random() * 31, 40 + random() * 90, 1); }
      ctx.fillRect((row % 3) * 80 + 12, row * 32, 1, 32);
    }
  } else {
    for (let n = 0; n < 6000; n++) { ctx.fillStyle = random() > .5 ? '#FFFDF815' : '#1F2A4409'; ctx.fillRect(random() * 256, random() * 256, 1, 1); }
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(kind === 'wood' ? 3 : 2, 3); return map;
}
