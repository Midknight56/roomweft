import { describe, expect, it, vi } from 'vitest';
import { MODEL, DEPRECATED_MODELS, buildPrompt, pick, validatePicks, type CandidateLists, type PickBinding, type PickInput } from '../../src/ai/pick';
import { eligibleCandidates } from '../../src/design/rules';
import { NeuronLedger } from '../../src/ai/ledger';
import { fixtureCandidate } from './recorded-fixture';
import { SLOTS, STYLES } from '../../src/shared/room';
import { asD1, freshD1, LEDGER_SQL } from './d1-fake';
const candidates:CandidateLists={
  'reading-chair':[fixtureCandidate('chair',['PU leather','rattan','wood'])],
  'floor-lamp':[fixtureCandidate('lamp',['antique bronze'])],
  'side-table':[{...fixtureCandidate('table',['mango wood']),colors:['#aa3333']}],
  rug:[fixtureCandidate('rug',['jute'])]};
const input:PickInput={style:STYLES[0],budgetCents:60000,candidates};
const valid=()=>({picks:SLOTS.map(s=>({slot:s.id,id:eligibleCandidates(input.budgetCents,s.id,candidates[s.id])[0]?.id,reason:'Warm wood and soft fabric suit the quiet mood.'}))});
const keyed=()=>Object.fromEntries(valid().picks.map(({slot,id,reason})=>[slot,{id,reason}]));

describe('taste picks',()=>{
  it('keeps the configured model out of the deprecation list',()=>{
    expect(MODEL).toBe('@cf/ibm-granite/granite-4.0-h-micro');
    expect(DEPRECATED_MODELS).toHaveLength(2);
    expect(DEPRECATED_MODELS).not.toContain(MODEL);
  });
  it('requires every slot and both fields in the schema and instruction',async()=>{
    const run=vi.fn<PickBinding['run']>().mockResolvedValue({response:keyed()});
    await pick(input,{run},{reserve:async()=>1,settle:vi.fn()});
    const request=run.mock.calls[0][1], schema=request.response_format.json_schema;
    expect(schema.required).toEqual(SLOTS.map(slot=>slot.id));
    expect(Object.keys(schema.properties as object)).toEqual(SLOTS.map(slot=>slot.id));
    for (const slot of SLOTS) {
      expect(schema.properties).toHaveProperty(slot.id,{type:'object',required:['id','reason'],properties:{id:{type:'string'},reason:{type:'string'}}});
      expect(request.messages[0].content).toContain(`"${slot.id}":{"id":"id","reason":"reason"}`);
    }
    expect(request.messages[0].content).toContain('one plain sentence of 8 to 16 words');
  });
  it('deduplicates colour names per product while preserving their order',()=>{
    const base=candidates['reading-chair'][0];
    const product={...base,id:'colour-test',colors:['#777777','#777777','#aa3333','#777777']};
    const prompt=buildPrompt({...input,candidates:{...candidates,'reading-chair':[product]}});
    expect(prompt).toMatch(/colour-test \|[^\n]*\| grey, warm red \|/);
  });
  it.each(['object','string','chat'])('accepts all four keyed picks from %s answers',async(shape)=>{
    const answer=keyed();
    const response=shape==='object'?{response:answer}:shape==='string'?{response:JSON.stringify(answer)}:
      {choices:[{message:{content:JSON.stringify(answer)}}]};
    const run=vi.fn<PickBinding['run']>().mockResolvedValue(response);
    expect(await pick(input,{run},{reserve:async()=>1,settle:vi.fn()})).toMatchObject({ok:true,picks:SLOTS.map(slot=>({slot:slot.id,by:'ai'}))});
  });
  it('prefers response over chat content and never retries a malformed selected response',async()=>{
    const run=vi.fn<PickBinding['run']>().mockResolvedValue({response:keyed(),choices:[{message:{content:'broken'}}]});
    const ledger={reserve:async()=>1,settle:vi.fn()};
    expect((await pick(input,{run},ledger)).ok).toBe(true);
    run.mockResolvedValueOnce({response:JSON.stringify(keyed()),choices:[{message:{content:'broken'}}]});
    expect((await pick(input,{run},ledger)).ok).toBe(true);
    run.mockResolvedValueOnce({response:'broken',choices:[{message:{content:JSON.stringify(keyed())}}]});
    expect(await pick(input,{run},ledger)).toEqual({ok:false,reason:'error'});
    expect(run).toHaveBeenCalledTimes(3);
  });
  it.each([{},null,{...keyed()},{response:[]},{response:12},{response:'null'},
    {response:'[]'},{response:'true'},{choices:[{message:{content:keyed()}}]},{choices:[]}])('rejects unsupported answer envelopes %j',async(response)=>{
    const run=vi.fn<PickBinding['run']>().mockResolvedValue(response);
    expect(await pick(input,{run},{reserve:async()=>1,settle:vi.fn()})).toEqual({ok:false,reason:'error'});
    expect(run).toHaveBeenCalledOnce();
  });
  it('validates each keyed slot and labels missing or invalid picks as rules',()=>{
    const answer=keyed();
    delete answer['floor-lamp'];
    answer['side-table'].id='foreign';
    answer.rug.reason='<b>Soft</b>';
    expect(validatePicks(answer,input).map(p=>p.by)).toEqual(['ai','rules','rules','rules']);
  });
  it.each([
    [0,'PU leather, rattan, wood, warm brown'],
    [1,'antique bronze, warm brown'],
    [2,'mango wood, warm red'],
    [3,'warm brown'],
  ] as const)('rejects saved material and colour lists for slot %s: %s',(index,reason)=>{
    const raw=valid(); raw.picks[index].reason=reason;
    expect(validatePicks(raw,input)[index].by).toBe('rules');
  });
  it('accepts a full sentence reason',()=>{
    const raw=valid(); raw.picks[0].reason='Grey linen and pale wood keep the corner quiet and light.';
    expect(validatePicks(raw,input)[0]).toMatchObject({by:'ai',reason:raw.picks[0].reason});
  });
  it('capitalises the first letter of a valid reason',()=>{
    const raw=valid(); raw.picks[0].reason='flannel fabric and warm brown wood create a cozy reading atmosphere.';
    expect(validatePicks(raw,input)[0]).toMatchObject({by:'ai',reason:'Flannel fabric and warm brown wood create a cozy reading atmosphere.'});
  });
  it('ignores case, commas and and when counting words outside product details',()=>{
    const raw=valid();
    raw.picks[0].reason='QUIET, ACCENT PIECE and HOME WORKSHOP, PU LEATHER RATTAN WOOD, WARM BROWN brings calm';
    expect(validatePicks(raw,input)[0].by).toBe('rules');
    raw.picks[0].reason+=' indoors';
    expect(validatePicks(raw,input)[0]).toMatchObject({by:'ai',reason:raw.picks[0].reason+'.'});
  });
  it.each(['','!','?'])('ends a valid sentence with a full stop instead of %j',ending=>{
    const raw=valid(), sentence='Grey linen and pale wood keep the corner quiet and light';
    raw.picks[0].reason=sentence+ending;
    expect(validatePicks(raw,input)[0]).toMatchObject({by:'ai',reason:sentence+'.'});
  });
  it('preserves a complete calm sentence beyond the former character and word cuts',()=>{
    const raw=valid();
    raw.picks[1].reason='The Oslo Floor Lamp with Japanese paper shades adds a touch of understated elegance that complements the peaceful atmosphere throughout this comfortable reading corner.';
    expect(raw.picks[1].reason.length).toBeGreaterThan(140);
    expect(raw.picks[1].reason.split(' ')).toHaveLength(24);
    expect(validatePicks(raw,input)[1]).toMatchObject({by:'ai',reason:raw.picks[1].reason});
    raw.picks[1].reason=raw.picks[1].reason.replace('comfortable','especially comfortable');
    expect(raw.picks[1].reason.split(' ')).toHaveLength(25);
    expect(validatePicks(raw,input)[1].by).toBe('rules');
  });
  it('cleans hyphens between letters before enforcing the word limit',()=>{
    const answer=keyed(); answer.rug.reason='Soft cotton-jute suits café-toned wood-and-wool.';
    expect(validatePicks(answer,input)[3]).toMatchObject({by:'ai',reason:'Soft cotton jute suits café toned wood and wool.'});
    answer.rug.reason=Array(18).fill('cotton-jute').join(' ');
    expect(validatePicks(answer,input)[3].by).toBe('rules');
  });
  it.each([1.518,1.579,0])('settles reported neurons %s ahead of token estimates',async(neurons)=>{
    const settle=vi.fn();
    const run=vi.fn<PickBinding['run']>().mockResolvedValue({choices:[{message:{content:JSON.stringify(keyed())}}],
      usage:{neurons,prompt_tokens:339,completion_tokens:104}});
    await pick(input,{run},{reserve:async()=>7,settle});
    expect(settle).toHaveBeenCalledExactlyOnceWith(7,neurons);
  });
  it.each([undefined,NaN,Infinity,'1.518'])('estimates granite token costs without finite numeric neurons %s',async(neurons)=>{
    const settle=vi.fn();
    const run=vi.fn<PickBinding['run']>().mockResolvedValue({response:keyed(),usage:{neurons,prompt_tokens:3000,completion_tokens:400}});
    await pick(input,{run},{reserve:async()=>7,settle});
    expect(settle).toHaveBeenCalledExactlyOnceWith(7,8.6892);
  });
  it.each([{prompt_tokens:-1,completion_tokens:1},{prompt_tokens:1,completion_tokens:Infinity},
    {prompt_tokens:'339',completion_tokens:104},{neurons:NaN}])('retains the hold for untrusted token usage %j',async(usage)=>{
    const settle=vi.fn(),run=vi.fn<PickBinding['run']>().mockResolvedValue({response:keyed(),usage});
    expect((await pick(input,{run},{reserve:async()=>7,settle})).ok).toBe(true);
    expect(settle).not.toHaveBeenCalled();
  });
  it('settles billed usage even when answer parsing fails',async()=>{
    const settle=vi.fn(),run=vi.fn<PickBinding['run']>().mockResolvedValue({response:'broken',usage:{neurons:1.518}});
    expect(await pick(input,{run},{reserve:async()=>7,settle})).toEqual({ok:false,reason:'error'});
    expect(settle).toHaveBeenCalledExactlyOnceWith(7,1.518);
  });
  it('uses the sized eligible list for both prompt and validation',()=>{
    const base=candidates['reading-chair'][0];
    const sized={...base,id:'sized-chair',priceCents:10000,dims:{w:58,d:58,h:80}};
    const unknown={...base,id:'unknown-chair',priceCents:9000,dims:null};
    const data={...input,candidates:{...candidates,'reading-chair':[unknown,sized]}};
    expect(buildPrompt(data)).toContain('sized-chair');
    expect(buildPrompt(data)).not.toContain('unknown-chair');
    expect(validatePicks({picks:[{slot:'reading-chair',id:unknown.id,reason:'Soft linen brings a quiet warmth to this calm reading corner.'}]},data)[0]).toMatchObject({id:sized.id,by:'rules'});
    const onlyUnknown={...data,candidates:{...data.candidates,'reading-chair':[unknown,{...sized,priceCents:30000}]}};
    expect(buildPrompt(onlyUnknown)).toContain('unknown-chair');
    expect(validatePicks({picks:[{slot:'reading-chair',id:unknown.id,reason:'Soft linen brings a quiet warmth to this calm reading corner.'}]},onlyUnknown)[0]).toMatchObject({id:unknown.id,by:'ai'});
  });
  it('accepts valid JSON with one call and settles actual usage',async()=>{
    const db=freshD1(LEDGER_SQL), ledger=new NeuronLedger(asD1(db));
    const run=vi.fn<PickBinding['run']>().mockResolvedValue({response:JSON.stringify(valid()),usage:{prompt_tokens:1000,completion_tokens:100}});
    const result=await pick(input,{run},ledger);
    expect(result).toMatchObject({ok:true,picks:SLOTS.map(s=>({slot:s.id,by:'ai'}))});
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe(MODEL);
    expect(run.mock.calls[0][1]).toMatchObject({max_tokens:400,temperature:.2,response_format:{type:'json_schema'}});
    expect(db.sqlite.prepare('SELECT neurons FROM ai_calls').get()?.neurons).toBeCloseTo(2.5578);
  });
  it('falls back by slot for foreign ids, duplicate slots, markup and size claims',()=>{
    const raw=valid(); raw.picks[0].id='foreign'; raw.picks[1].reason='<b>Warm</b>';
    raw.picks[2].reason='Fits a small size'; raw.picks.push({...raw.picks[3]});
    expect(validatePicks(raw,input).every(p=>p.by==='rules')).toBe(true);
  });
  it('rejects a 30 word reason and strips links and dollar amounts',()=>{
    const raw=valid(); raw.picks[0].reason='Soft textures bring a peaceful atmosphere to this corner every evening and help create a restful place to enjoy reading while gentle colours keep the room feeling quiet and welcoming.';
    expect(raw.picks[0].reason.split(' ')).toHaveLength(30);
    raw.picks[1].reason='Soft linen https://example.com $12.99 www.example.org shop.example.dev $-25 keeps this corner feeling calm and balanced.';
    const result=validatePicks(raw,input);
    expect(result[0].by).toBe('rules');
    expect(result[1].reason).toBe('Soft linen keeps this corner feeling calm and balanced.');
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
    expect(db.sqlite.prepare('SELECT SUM(neurons) AS n FROM ai_calls').get()).toMatchObject({n:20});
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
  expect(validatePicks({picks:[{slot:'reading-chair',id:'over-cap',reason:'Soft linen brings a quiet warmth to this calm reading corner.'}]},data)[0]).toMatchObject({id:'eligible',by:'rules'});
  expect(validatePicks({picks:[{slot:'reading-chair',id:'eligible',reason:'Soft linen brings a quiet warmth to this calm reading corner.'}]},data)[0].by).toBe('ai');
});
