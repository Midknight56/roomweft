import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const bundle = await build({ entryPoints: ['src/products/channel3.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { withSlotDims } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
for (const style of ['calm-studio', 'night-desk', 'warm-reading']) {
  const path = `src/design/recorded/${style}.json`;
  const run = JSON.parse(await readFile(path, 'utf8'));
  for (const [slot, list] of Object.entries(run.slots)) {
    for (const candidate of list.candidates) candidate.dims = withSlotDims(candidate, slot).dims;
  }
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`);
  const rugs = run.slots.rug.candidates;
  console.log(`${style}: ${rugs.filter(candidate => candidate.dims !== null).length} of ${rugs.length} rugs sized`);
}
