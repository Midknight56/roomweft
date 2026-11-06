import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { saveLiveRuns, saveLiveRunCli } from '../../tools/save-live-run.mjs';
import { SLOTS, STYLES, OWNED_ITEMS } from '../../src/shared/room';
import { recordedRuns } from '../../src/design/recorded';

function fake(mode = 'live', mixed = false) {
  let remaining = 1000;
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/scenes') return Response.json({ styles: STYLES, owned: OWNED_ITEMS, slots: SLOTS });
    if (path === '/api/status') return Response.json({ ai: { remainingNeuronsToday: remaining } });
    const body = JSON.parse(String(init?.body)) as { style: keyof typeof recordedRuns };
    remaining -= 12;
    return Response.json({mode, slots:SLOTS.map((s,index) => {
      const record = recordedRuns[body.style].slots[s.id];
      return { slot:s.id,pick:record.candidates[1] ?? record.candidates[0],by:'ai',reason:'Soft colours.',
        alternates: record.candidates.filter((_,i)=>i!==(record.candidates.length>1?1:0)).map(candidate=>({candidate})),
        source:{...record,origin:mixed && index===1?'recorded':'live'} };
    })});
  });
}
describe('save live runs', () => {
  it('writes source ordered captures, taste picks, usage and all saved pick files',async () => {
    const root = await mkdtemp(join(process.cwd(),'save-test-')); const fetcher = fake();
    try {
      await writeFile(join(root,'previous.ai.json'),JSON.stringify({picks:[],neurons:1,at:'past'}));
      await saveLiveRuns('http://room.test',{root,fetcher,now:()=>100});
      const saved = JSON.parse(await readFile(join(root,'saved-picks.json'),'utf8'));
      expect(saved.previous.neurons).toBe(1);
      for (const style of STYLES) {
        const capture = JSON.parse(await readFile(join(root,`${style.id}.json`),'utf8'));
        expect(capture).toEqual(recordedRuns[style.id]);
        const ai = JSON.parse(await readFile(join(root,`${style.id}.ai.json`),'utf8'));
        expect(ai).toEqual(saved[style.id]); expect(ai.neurons).toBe(12); expect(ai.at).toBe(new Date(100).toISOString());
        expect(ai.picks).toHaveLength(4); expect(ai.picks[0]).toMatchObject({slot:'reading-chair',by:'ai',reason:'Soft colours.'});
      }
      expect(fetcher.mock.calls.map(c=>new URL(String(c[0])).pathname)).toEqual(['/api/scenes',...STYLES.flatMap(()=>['/api/status','/api/design','/api/status'])]);
      const posts = fetcher.mock.calls.filter(c=>c[1]?.method==='POST');
      posts.forEach((call,i)=>{
        expect(JSON.parse(String(call[1]?.body))).toMatchObject({style:STYLES[i].id,budget:STYLES[i].defaultBudget,live:true});
        expect(call[1]?.headers).toMatchObject({Cookie:`rw_v=save-${STYLES[i].id}-100`});
      });
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it.each([['recorded',false],['rules',false],['live',true]])('refuses %s with mixed sources %s without writing',async (mode,mixed) => {
    const root = await mkdtemp(join(process.cwd(),'save-test-'));
    try {
      await expect(saveLiveRuns('http://room.test',{root,fetcher:fake(mode,mixed)})).rejects.toThrow('No files written');
      const error = vi.spyOn(console,'error').mockImplementation(()=>{});
      try { expect(await saveLiveRunCli('http://room.test',{root,fetcher:fake(mode,mixed)})).toBe(1); expect(error).toHaveBeenCalledWith(expect.stringContaining('No files written')); } finally { error.mockRestore(); }
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root,{recursive:true,force:true}); }
  });
});
