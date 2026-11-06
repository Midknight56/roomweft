import { describe, expect, it, vi } from 'vitest';
import { buildPrompt, pick, validatePicks, type CandidateLists, type PickBinding, type PickInput } from '../../src/ai/pick';
import { eligibleCandidates } from '../../src/design/rules';
import { NeuronLedger } from '../../src/ai/ledger';
import { recordedRuns } from '../../src/design/recorded';
import { SLOTS, STYLES } from '../../src/shared/room';
import { asD1, freshD1, LEDGER_SQL } from './d1-fake';
const candidates:CandidateLists={...recordedRuns['warm-reading'].slots,
  'reading-chair':recordedRuns['warm-reading'].slots['reading-chair'].candidates,
  'floor-lamp':recordedRuns['warm-reading'].slots['floor-lamp'].candidates,
  'side-table':recordedRuns['warm-reading'].slots['side-table'].candidates,
  rug:recordedRuns['warm-reading'].slots.rug.candidates};
const input:PickInput={style:STYLES[0],budgetCents:60000,candidates};
const valid=()=>({picks:SLOTS.map(s=>({slot:s.id,id:eligibleCandidates(input.budgetCents,s.id,candidates[s.id])[0]?.id,reason:'Warm wood and soft fabric suit the quiet mood.'}))});
describe('taste picks',()=>{
  it('uses the sized eligible list for both prompt and validation',()=>{
    const base=candidates['reading-chair'][0];
    const sized={...base,id:'sized-chair',priceCents:10000,dims:{w:58,d:58,h:80}};
    const unknown={...base,id:'unknown-chair',priceCents:9000,dims:null};
    const data={...input,candidates:{...candidates,'reading-chair':[unknown,sized]}};
    expect(buildPrompt(data)).toContain('sized-chair');
    expect(buildPrompt(data)).not.toContain('unknown-chair');
    expect(validatePicks({picks:[{slot:'reading-chair',id:unknown.id,reason:'Soft linen.'}]},data)[0]).toMatchObject({id:sized.id,by:'rules'});
    const onlyUnknown={...data,candidates:{...data.candidates,'reading-chair':[unknown,{...sized,priceCents:30000}]}};
    expect(buildPrompt(onlyUnknown)).toContain('unknown-chair');
    expect(validatePicks({picks:[{slot:'reading-chair',id:unknown.id,reason:'Soft linen.'}]},onlyUnknown)[0]).toMatchObject({id:unknown.id,by:'ai'});
  });
  it('accepts valid JSON with one call and settles actual usage',async()=>{
    const db=freshD1(LEDGER_SQL), ledger=new NeuronLedger(asD1(db));
    const run=vi.fn<PickBinding['run']>().mockResolvedValue({response:JSON.stringify(valid()),usage:{prompt_tokens:1000,completion_tokens:100}});
    const result=await pick(input,{run},ledger);
    expect(result).toMatchObject({ok:true,picks:SLOTS.map(s=>({slot:s.id,by:'ai'}))});
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe('@cf/meta/llama-3.2-3b-instruct');
    expect(run.mock.calls[0][1]).toMatchObject({max_tokens:400,temperature:.2,response_format:{type:'json_schema'}});
    expect(db.sqlite.prepare('SELECT neurons FROM ai_calls').get()?.neurons).toBeCloseTo(7.6725);
  });
  it('falls back by slot for foreign ids, duplicate slots, markup and size claims',()=>{
    const raw=valid(); raw.picks[0].id='foreign'; raw.picks[1].reason='<b>Warm</b>';
    raw.picks[2].reason='Fits a small size'; raw.picks.push({...raw.picks[3]});
    expect(validatePicks(raw,input).every(p=>p.by==='rules')).toBe(true);
  });
  it('cuts long reasons and strips links and dollar amounts',()=>{
    const raw=valid(); raw.picks[0].reason='a'.repeat(200);
    raw.picks[1].reason='Soft linen https://example.com $12.99 www.example.org shop.example.dev $-25 warm mood';
    const result=validatePicks(raw,input);
    expect(result[0].reason).toHaveLength(140); expect(result[0].by).toBe('ai');
    expect(result[1].reason).toBe('Soft linen warm mood');
    expect(result.every(p=>p.reason.split(/\s+/).length<=18)).toBe(true);
  });
  it('does not call without a reservation or binding',async()=>{
    const run=vi.fn<PickBinding['run']>(), settle=vi.fn(), reserve=vi.fn().mockResolvedValue(null);
    expect(await pick(input,{run},{reserve,settle})).toEqual({ok:false,reason:'capped'});
    expect(await pick(input,undefined,{reserve,settle})).toEqual({ok:false,reason:'off'});
    expect(run).not.toHaveBeenCalled(); expect(reserve).toHaveBeenCalledTimes(1);
    reserve.mockRejectedValueOnce(new Error('ledger down'));
    expect(await pick(input,{run},{reserve,settle})).toEqual({ok:false,reason:'capped'});
    expect(run).not.toHaveBeenCalled();
  });
  it('keeps the hold without usage and never retries thrown format errors',async()=>{
    const db=freshD1(LEDGER_SQL), ledger=new NeuronLedger(asD1(db));
    const run=vi.fn<PickBinding['run']>().mockResolvedValueOnce({response:JSON.stringify(valid())}).mockRejectedValueOnce(new Error('format unsupported'));
    expect((await pick(input,{run},ledger)).ok).toBe(true);
    expect(await pick(input,{run},ledger)).toEqual({ok:false,reason:'error'});
    expect(run).toHaveBeenCalledTimes(2);
    expect(db.sqlite.prepare('SELECT SUM(neurons) AS n FROM ai_calls').get()).toMatchObject({n:90});
  });
  it('rejects oversized prompts before reserving and keeps compact lines to six candidates',async()=>{
    const huge={...input,candidates:{...candidates,'reading-chair':[{...candidates['reading-chair'][0],priceCents:1,materials:['x'.repeat(11000)]}]}};
    const reserve=vi.fn(),settle=vi.fn(),run=vi.fn<PickBinding['run']>();
    expect(await pick(huge,{run},{reserve,settle})).toEqual({ok:false,reason:'prompt'});
    expect(reserve).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    const c={...candidates['reading-chair'][0],id:'compact',priceCents:1,title:'t'.repeat(100),dims:null};
    const text=buildPrompt({...input,candidates:{...candidates,'reading-chair':Array.from({length:8},()=>c)}});
    expect(text.match(/compact \|/g)).toHaveLength(6);
    expect(text).toContain('t'.repeat(70)+' |'); expect(text).toContain('size unknown');
  });
  it('parses fenced text, and rejects malformed JSON without another call',async()=>{
    const ledger={reserve:vi.fn().mockResolvedValue(1),settle:vi.fn()};
    const run=vi.fn<PickBinding['run']>().mockResolvedValueOnce({response:'```json\n'+JSON.stringify(valid())+'\n```'}).mockResolvedValueOnce({response:'broken'});
    expect((await pick(input,{run},ledger)).ok).toBe(true);
    expect(await pick(input,{run},ledger)).toEqual({ok:false,reason:'error'});
    expect(run).toHaveBeenCalledTimes(2);
  });
});

it('shows only eligible candidates with slot caps and rejects an over cap saved id', () => {
  const base = candidates['reading-chair'][0];
  const data = {...input,candidates:{...candidates,'reading-chair':[{...base,id:'over-cap',priceCents:24001},{...base,id:'eligible',priceCents:24000}]}};
  expect(buildPrompt(data)).toContain('reading-chair (up to $240):');
  expect(buildPrompt(data)).not.toContain('over-cap');
  expect(validatePicks({picks:[{slot:'reading-chair',id:'over-cap',reason:'Soft linen.'}]},data)[0]).toMatchObject({id:'eligible',by:'rules'});
  expect(validatePicks({picks:[{slot:'reading-chair',id:'eligible',reason:'Soft linen.'}]},data)[0].by).toBe('ai');
});
