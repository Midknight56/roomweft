import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function saveLiveRuns(baseUrl, { fetcher = fetch, root = 'src/design/recorded', now = Date.now } = {}) {
  const request = async (path, cookie, body) => {
    const response = await fetcher(new URL(path, baseUrl), {
      method: body ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`${path} returned ${response.status}.`);
    return response.json();
  };
  const scenes = await request('/api/scenes', '');
  for (const style of scenes.styles) {
    const cookie = `rw_v=save-${style.id}-${now()}`;
    const before = await request('/api/status', cookie);
    const design = await request('/api/design', cookie, { style: style.id, budget: style.defaultBudget,
      owned: scenes.owned.map(({ id, x, z, rot, locked }) => ({ id, x, z, rot, locked })), live: true });
    const after = await request('/api/status', cookie);
    if (design.mode !== 'live') throw new Error(`${style.id}: refused ${design.mode} mode. No files written for this style.`);
    if (design.slots.length !== scenes.slots.length || scenes.slots.some(slot => !design.slots.some(s => s.slot === slot.id && s.source?.origin === 'live')))
      throw new Error(`${style.id}: every slot must have a live source. No files written for this style.`);
    const slots = {};
    for (const slot of design.slots) {
      const source = slot.source;
      const candidates = [slot.pick, ...slot.alternates.map(alt => alt.candidate)].filter(Boolean);
      const ordered = source.resultIds.map(id => candidates.find(candidate => candidate.id === id));
      if (ordered.some(candidate => !candidate)) throw new Error(`${style.id}: a source candidate is missing. No files written for this style.`);
      slots[slot.slot] = { query: source.query, maxPrice: source.maxPrice, resultIds: source.resultIds, retrievedAt: source.retrievedAt, candidates: ordered };
    }
    const neurons = before.ai.remainingNeuronsToday - after.ai.remainingNeuronsToday;
    if (!Number.isFinite(neurons) || neurons < 0) throw new Error(`${style.id}: invalid neuron usage. No files written for this style.`);
    const at = new Date(now()).toISOString();
    const record = { style: style.id, capturedAt: new Date(Math.max(...design.slots.map(slot => slot.source.retrievedAt))).toISOString(), slots };
    const ai = { picks: design.slots.map(({ slot, pick, reason, by }) => ({ slot, id: pick?.id ?? null, reason, by })), neurons, at };
    await writeFile(`${root}/${style.id}.json`, `${JSON.stringify(record,null,2)}\n`);
    await writeFile(`${root}/${style.id}.ai.json`, `${JSON.stringify(ai,null,2)}\n`);
    const saved = {};
    for (const file of (await readdir(root)).filter(file => file.endsWith('.ai.json')).sort()) {
      saved[file.slice(0,-8)] = JSON.parse(await readFile(`${root}/${file}`,'utf8'));
    }
    await writeFile(`${root}/saved-picks.json`, `${JSON.stringify(saved,null,2)}\n`);
    console.log(`Saved ${style.id}. Neurons used: ${neurons}.`);
  }
}
export async function saveLiveRunCli(baseUrl, options) {
  try {
    if (!baseUrl) throw new Error('Usage: node tools/save-live-run.mjs <baseUrl>');
    await saveLiveRuns(baseUrl, options);
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : 'Could not save the live run.'); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await saveLiveRunCli(process.argv[2]);
}
