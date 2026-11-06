import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignService, designLayout, type DesignInput } from '../../src/design/service';
import { NeuronLedger } from '../../src/ai/ledger';
import { validatePicks, type PickBinding } from '../../src/ai/pick';
import { OWNED_ITEMS, SLOTS, STYLES, placeAtAnchor } from '../../src/shared/room';
import type { Candidate, DesignView } from '../../src/shared/api-types';
import type { ProductCandidate, SearchResult } from '../../src/products/channel3';
import { recordedPicks, recordedRuns } from '../../src/design/recorded';
import { asD1, freshD1, LEDGER_SQL } from './d1-fake';
import { makeRecordedData } from './recorded-fixture';
vi.mock('../../src/design/recorded',async()=>{
  const {makeRecordedData}=await import('./recorded-fixture');
  return makeRecordedData();
});
beforeEach(()=>{
  Object.assign(recordedRuns,makeRecordedData().recordedRuns);
  for (const style of STYLES) delete recordedPicks[style.id];
});
const at=Date.UTC(2026,10,6,12);
const candidate=(id:string,w:number,d:number,priceCents:number):ProductCandidate=>({id,title:id==='large'?'Large chair':'Jearey chair',priceCents,currency:'USD',url:'https://shop.example/chair',domain:'shop.example',colors:['#eeeeee'],materials:['linen'],dims:{w,d,h:90},dimsRaw:null});
const large=candidate('large',90,100,24000), small=candidate('small',58,58,18600);
function fixture(options:{fail?:boolean;ai?:boolean;empty?:boolean;unknown?:boolean;table?:boolean}={}) {
  const db=freshD1(LEDGER_SQL);
  const search=vi.fn<(query:string,maxPrice:number)=>Promise<SearchResult>>().mockImplementation(async(query,maxPrice)=>{
    if (options.fail) return {ok:false,reason:'spent'};
    const candidates=options.empty?[]:query===STYLES[0].queries['reading-chair'] ? options.unknown?[{...small,dims:null}]:[large,small]
      :options.table && query===STYLES[0].queries['side-table'] ? [candidate('table',30,30,3000),candidate('table-small',20,20,2000)]:[];
    return {ok:true,candidates,source:{query,maxPrice,resultIds:candidates.map(c=>c.id),retrievedAt:at,cached:false,origin:'live'}};
  });
  const run=vi.fn<PickBinding['run']>().mockResolvedValue({response:JSON.stringify({picks:[{slot:'reading-chair',id:'large',reason:'Soft linen brings a quiet warmth to this calm reading corner.'}]})});
  let n=0;
  const service=new DesignService({db:asD1(db),search:{search},ledger:new NeuronLedger(asD1(db),()=>at),ai:options.ai?{run}:undefined,now:()=>at,id:()=>`design-${++n}`});
  const input:DesignInput={style:'warm-reading',budget:600,owned:OWNED_ITEMS.map(i=>({id:i.id,x:i.x,z:i.z,rot:i.rot,locked:i.locked})),live:true,visitorId:'visitor'};
  return {db,search,run,service,input};
}
describe('design service',()=>{
  it('uses keyed chat picks with clean public reasons and reported neurons',async()=>{
    const {service,input,run,db}=fixture({ai:true});
    run.mockResolvedValueOnce({choices:[{message:{content:JSON.stringify({'reading-chair':{id:'large',reason:'Soft cotton jute adds warmth and suits this quiet reading corner.'}})}}],usage:{neurons:1.518}});
    const design=await service.createDesign(input);
    expect(design.mode).toBe('live'); expect(design.labels.ai).toBe('live');
    expect(design.slots[0]).toMatchObject({by:'ai',reason:'Soft cotton jute adds warmth and suits this quiet reading corner.',pick:{id:'large'}});
    expect(db.sqlite.prepare('SELECT neurons FROM ai_calls').get()).toMatchObject({neurons:1.518});
  });
  it('labels unsupported model answers as rules',async()=>{
    const {service,input,run}=fixture({ai:true});
    run.mockResolvedValueOnce({choices:[{message:{content:{'reading-chair':{id:'large',reason:'Soft linen brings a quiet warmth to this calm reading corner.'}}}}]});
    const design=await service.createDesign(input);
    expect(design.mode).toBe('rules'); expect(design.labels.ai).toBe('rules');
    expect(design.slots[0].by).toBe('rules');
  });
  it('anchors an unsized affordable chair and its follower using a nominal box',async()=>{
    const {service,input,search}=fixture({unknown:true,table:true});
    search.mockResolvedValueOnce({ok:true,candidates:[{...small,dims:null},{...large,priceCents:30000}],
      source:{query:'chair',maxPrice:240,resultIds:['small','large'],retrievedAt:at,cached:false,origin:'live'}});
    const design=await service.createDesign(input);
    expect(design.slots[0].pick?.id).toBe('small');
    expect(design.slots[0].placement).toEqual({x:341,z:39,rot:270,nominal:true});
    expect(designLayout(design).find(p=>p.id==='reading-chair')).toMatchObject({w:70,d:70,h:80,dims:'unverified'});
    expect(design.slots[2].placement).toEqual({x:366,z:90,rot:0});
    expect(design.fit.unverified).toContain('reading-chair');
    expect(design.fit.overlaps).toEqual([]);
    expect(design.fit.walkway.targets.some(p=>p.id==='reading-chair')).toBe(false);
    const moved=await service.move(design.id,'visitor','reading-chair',330,50,270);
    expect(moved.slots[0].placement).toMatchObject({nominal:true,moved:true});
    const swapped=await service.swap(design.id,'visitor','reading-chair','large');
    expect(swapped.slots[0].placement).toEqual({x:330,z:50,rot:270,moved:true});
    expect(swapped.slots[0].alternates.find(a=>a.candidate.id==='small')?.verified).toBe(false);
  });
  it('anchors unsized lamps, tables and rugs and a table with no chair',async()=>{
    const {service,input,search}=fixture();
    search.mockImplementation(async(query,maxPrice)=>({ok:true,candidates:query===STYLES[0].queries['reading-chair']?[]:[{...small,id:query,priceCents:1000,dims:null}],
      source:{query,maxPrice,resultIds:[query],retrievedAt:at,cached:false,origin:'live'}}));
    const design=await service.createDesign(input);
    expect(design.slots.map(s=>s.placement)).toEqual([null,{x:24,z:296,rot:90,nominal:true},{x:353.5,z:102.5,rot:0,nominal:true},{x:190,z:150,rot:0,nominal:true}]);
    expect(design.fit.unverified).toEqual(['floor-lamp','side-table','rug']);
    expect(design.fit.overlaps).toEqual([]);
  });
  it('keeps the sized saved model chair and recomputes saved rules reasons at the current budget',async()=>{
    const slots=recordedRuns['calm-studio'].slots;
    slots['reading-chair'].candidates=[{...small,dims:null},small,large];
    slots['side-table'].candidates=[{...candidate('saved-table',30,30,3000),materials:['oak']}];
    for (const slot of Object.values(slots)) slot.resultIds=slot.candidates.map(c=>c.id);
    const reason='Soft linen brings a quiet warmth to this calm reading corner.';
    recordedPicks['calm-studio']={picks:[
      {slot:'reading-chair',id:large.id,reason,by:'ai'},
      {slot:'side-table',id:'saved-table',reason:'Under the $150 share for this piece. Oak matches the style.',by:'rules'},
    ],neurons:1,at:new Date(at).toISOString()};
    const {service,input,run}=fixture({ai:true});
    const design=await service.createDesign({...input,style:'calm-studio',budget:900,live:false});
    expect(design.slots[0]).toMatchObject({pick:large,reason});
    expect(design.slots[2].reason).toBe('Under the $135 share for this piece. Oak matches the style.');
    const lower=await service.createDesign({...input,style:'calm-studio',budget:800,live:false});
    expect(lower.slots[0]).toMatchObject({pick:large,reason});
    expect(lower.slots[2].reason).toBe('Under the $120 share for this piece. Oak matches the style.');
    expect(run).not.toHaveBeenCalled();
  });
  it('reports door failure for a 90 cm chair and a passing 58 cm alternate',async()=>{
    const {service,input,run}=fixture({ai:true});
    const design=await service.createDesign(input), chair=design.slots[0];
    expect(design.mode).toBe('live'); expect(chair.by).toBe('ai');
    expect(design.fit.doorSwing).toContain('reading-chair');
    expect(chair.alternates[0]).toMatchObject({candidate:{id:'small'},fit:{passes:true},priceDeltaCents:-5400});
    expect(design.totals.totalCents).toBe(24000); expect(run).toHaveBeenCalledTimes(1);
    expect(await service.get(design.id,'visitor')).toEqual(design);
  });
  it('swaps with numbers, bumps version and never calls the model again',async()=>{
    const {service,input,run}=fixture({ai:true});
    const initial=await service.createDesign(input);
    const swapped=await service.swap(initial.id,'visitor','reading-chair','small');
    expect(swapped.slots[0].placement).toEqual(placeAtAnchor(SLOTS[0],small.dims!,designLayout(initial)));
    expect(swapped.slots[0].placement).toEqual({x:347,z:33,rot:270});
    expect({passes:swapped.fit.passes,messages:swapped.fit.messages}).toEqual(initial.slots[0].alternates[0].fit);
    expect(swapped.version).toBe(2); expect(swapped.fit.passes).toBe(true);
    expect(swapped.swapNote).toContain('58 cm wide'); expect(swapped.swapNote).toContain('clears the door swing');
    expect(swapped.swapNote).toContain('saves $54.00');
    expect(swapped.slots[0].alternates.map(a=>a.candidate.id)).toContain('large');
    expect(run).toHaveBeenCalledTimes(1);
    await expect(service.swap(initial.id,'visitor','reading-chair','foreign')).rejects.toThrow('Choose a product from this slot.');
  });
  it('reanchors the side table after a chair swap and previews the same layout',async()=>{
    const {service,input}=fixture({ai:true,table:true});
    const initial=await service.createDesign(input);
    expect(initial.slots[2].placement).toEqual({x:366,z:110,rot:0});
    const preview=initial.slots[0].alternates[0].fit;
    const swapped=await service.swap(initial.id,'visitor','reading-chair','small');
    expect(swapped.slots[2].placement).toEqual({x:366,z:78,rot:0});
    expect(swapped.slots[2].placement).toEqual(placeAtAnchor(SLOTS[2],swapped.slots[2].pick!.dims!,designLayout(swapped)));
    expect({passes:swapped.fit.passes,messages:swapped.fit.messages}).toEqual(preview);
    expect((await service.get(initial.id,'visitor')).slots[2].placement).toEqual(swapped.slots[2].placement);
  });
  it('keeps a hand moved side table through chair moves and swaps and its own swap',async()=>{
    const {service,input}=fixture({ai:true,table:true});
    const initial=await service.createDesign(input);
    const placement={x:170,z:180,rot:90 as const,moved:true as const};
    const moved=await service.move(initial.id,'visitor','side-table',placement.x,placement.z,placement.rot);
    expect(moved.slots[2].placement).toEqual(placement);
    await service.move(initial.id,'visitor','reading-chair',340,80,270);
    const chairSwap=await service.swap(initial.id,'visitor','reading-chair','small');
    expect(chairSwap.slots[2].placement).toEqual(placement);
    const tableSwap=await service.swap(initial.id,'visitor','side-table','table');
    expect(tableSwap.slots[2].pick?.id).toBe('table');
    expect(tableSwap.slots[2].placement).toEqual(placement);
  });
  it('refuses a locked desk, unlocks its chair too, then moves both and can relock',async()=>{
    const {service,input}=fixture();
    const initial=await service.createDesign(input);
    await expect(service.move(initial.id,'visitor','desk',300,280,0)).rejects.toThrow('The desk is locked. Unlock it first.');
    const unlocked=await service.setLock(initial.id,'visitor','desk',false);
    expect(unlocked.owned.filter(i=>['desk','desk-chair'].includes(i.id)).every(i=>!i.locked)).toBe(true);
    const moved=await service.move(initial.id,'visitor','desk',300,280,0);
    expect(moved.version).toBe(3);
    expect(moved.owned.find(i=>i.id==='desk-chair')).toMatchObject({x:302.5,z:217.5});
    const locked=await service.setLock(initial.id,'visitor','desk-chair',true);
    expect(locked.version).toBe(4);
    await expect(service.move(initial.id,'visitor','desk-chair',200,200,0)).rejects.toThrow('The desk is locked.');
  });
  it('moves slot items and reports fit failures; invalid positions and ids are refused',async()=>{
    const {service,input}=fixture();
    const design=await service.createDesign(input);
    const moved=await service.move(design.id,'visitor','reading-chair',250,40,0);
    expect(moved.fit.doorSwing).toContain('reading-chair'); expect(moved.version).toBe(2);
    await expect(service.move(design.id,'visitor','reading-chair',NaN,40,0)).rejects.toThrow('valid position');
    await expect(service.move(design.id,'visitor','missing',100,100,0)).rejects.toThrow('not found');
    await expect(service.setLock(design.id,'visitor','missing',true)).rejects.toThrow('owned item');
  });
  it('keeps a visitor move during swaps and makes previews match the actual swap',async()=>{
    const {service,input}=fixture({ai:true,table:true}); const design=await service.createDesign(input);
    const moved=await service.move(design.id,'visitor','reading-chair',330,90,270);
    const preview=moved.slots[0].alternates[0].fit;
    const swapped=await service.swap(design.id,'visitor','reading-chair','small');
    expect(swapped.slots[0].placement).toEqual({x:330,z:90,rot:270,moved:true});
    expect(swapped.slots[2].placement).toEqual({x:366,z:135,rot:0});
    expect({passes:swapped.fit.passes,messages:swapped.fit.messages}).toEqual(preview);
  });
  it('hides every operation from another visitor',async()=>{
    const {service,input}=fixture(); const design=await service.createDesign(input);
    for (const request of [()=>service.get(design.id,'other'),()=>service.swap(design.id,'other','reading-chair','small'),
      ()=>service.move(design.id,'other','desk',1,1,0),()=>service.setLock(design.id,'other','desk',false)])
      await expect(request()).rejects.toThrow('not found');
  });
  it('rejects one of two stale concurrent version writes',async()=>{
    const {service,input,db}=fixture(); const design=await service.createDesign(input);
    const results=await Promise.allSettled([service.move(design.id,'visitor','reading-chair',340,50,270),service.move(design.id,'visitor','reading-chair',330,50,270)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const failure=results.find(r=>r.status==='rejected');
    expect(failure?.status==='rejected' && String(failure.reason)).toContain('changed, reload');
    expect(db.sqlite.prepare('SELECT version FROM designs').get()).toMatchObject({version:2});
  });
  it('uses recorded candidates and labels when all searches fail without a model call',async()=>{
    const {service,input,run,search}=fixture({fail:true,ai:true});
    const design=await service.createDesign(input);
    expect(design.mode).toBe('recorded'); expect(design.labels.search).toBe('recorded');
    expect(design.capturedAt).toBe(recordedRuns['warm-reading'].capturedAt);
    expect(design.slots.every(s=>s.by==='recorded' && s.source?.origin==='recorded' && s.note?.includes('spent'))).toBe(true);
    expect(run).not.toHaveBeenCalled(); expect(search).toHaveBeenCalledTimes(4);
  });
  it('uses recorded data without live requests and after the visitor reaches three',async()=>{
    const {service,input,search}=fixture();
    expect((await service.createDesign({...input,live:false})).mode).toBe('recorded');
    expect(search).not.toHaveBeenCalled();
    for (let i=0;i<3;i++) expect((await service.createDesign(input)).mode).toBe('rules');
    search.mockClear();
    expect((await service.createDesign(input)).mode).toBe('recorded'); expect(search).not.toHaveBeenCalled();
  });
  it('preserves successful empty searches as empty slots',async()=>{
    const {service,input}=fixture({empty:true}); const design=await service.createDesign(input);
    expect(design.slots.every(s=>s.pick===null && s.by==='none' && s.note==='No products were found for this slot.')).toBe(true);
    expect(design.totals.totalCents).toBe(0); expect(design.mode).toBe('rules');
  });
  it('keeps unknown sizes unverified and includes their price',async()=>{
    const {service,input}=fixture({unknown:true}); const design=await service.createDesign(input);
    expect(design.fit.unverified).toContain('reading-chair'); expect(design.totals.unverifiedCount).toBe(1);
    expect(design.totals.totalCents).toBe(18600); expect(design.slots[0].pick?.dims).toBeNull();
  });
  it('uses recorded candidates only for the failed slot',async()=>{
    const {service,input,search}=fixture(); search.mockResolvedValueOnce({ok:false,reason:'error'});
    const design=await service.createDesign(input);
    expect(design.mode).toBe('rules'); expect(design.slots[0].by).toBe('recorded');
    expect(design.slots[0].note).toContain('recorded products');
    expect(design.slots.slice(1).every(s=>s.source?.origin==='live')).toBe(true);
  });
  it('uses optional saved taste picks through the same fit pipeline with no call',async()=>{
    const previous=recordedPicks['warm-reading'];
    try {
      const slots=recordedRuns['warm-reading'].slots;
      recordedPicks['warm-reading']={picks:SLOTS.map(s=>({slot:s.id,id:slots[s.id].candidates[0].id,reason:'Soft textures bring a quiet warmth to this reading corner.',by:'ai'})),neurons:20,at:new Date(at).toISOString()};
      const {service,input,run}=fixture({ai:true});
      const design=await service.createDesign({...input,live:false});
      expect(design.labels.ai).toBe('recorded'); expect(design.mode).toBe('recorded');
      const expected=validatePicks(recordedPicks['warm-reading'],{style:STYLES[0],budgetCents:input.budget*100,candidates:{'reading-chair':slots['reading-chair'].candidates,'floor-lamp':slots['floor-lamp'].candidates,'side-table':slots['side-table'].candidates,rug:slots.rug.candidates}});
      for (const s of design.slots) expect(s.pick?.id).toBe(expected.find(p=>p.slot===s.slot)?.id);
      expect(design.fit.budget.total).toBe(design.slots.reduce((n,s)=>n+(s.pick?.priceCents ?? 0),0));
      expect(run).not.toHaveBeenCalled();
    } finally { if (previous) recordedPicks['warm-reading']=previous; else delete recordedPicks['warm-reading']; }
  });
  it('falls back to rules when the neuron ledger is full',async()=>{
    const {service,input,db,run}=fixture({ai:true});
    db.sqlite.exec("INSERT INTO ai_calls (app,day,neurons) VALUES ('roomweft','2026-11-06',1191)");
    const design=await service.createDesign(input);
    expect(design.mode).toBe('rules'); expect(design.slots[0].by).toBe('rules');
    expect(run).not.toHaveBeenCalled();
  });
  it('counts unknown dimensions in budget failure and refreshes totals after a swap',async()=>{
    const {service,input,search}=fixture({unknown:true});
    const expensive={...small,id:'expensive',priceCents:20000,dims:null};
    search.mockResolvedValueOnce({ok:true,candidates:[expensive,{...small,priceCents:10000,dims:null}],source:{query:'chair',maxPrice:150,resultIds:['expensive','small'],retrievedAt:at,cached:false,origin:'live'}});
    const design=await service.createDesign({...input,budget:150});
    const swapped=await service.swap(design.id,'visitor','reading-chair','expensive');
    expect(swapped.fit.budget.over).toBe(5000); expect(swapped.fit.passes).toBe(false);
    expect(swapped.totals).toMatchObject({totalCents:20000,overCents:5000,unverifiedCount:1});
    expect(swapped.swapNote).toContain('size unverified'); expect(swapped.swapNote).toContain('adds $100.00');
  });
  it('validates styles, whole dollar budgets, owned ids, locked defaults and room bounds',async()=>{
    const {service,input,search}=fixture();
    const changed=(id:string,props:Record<string,unknown>)=>input.owned.map(o=>o.id===id?{...o,...props}:o);
    for (const bad of [{style:'unknown'},{budget:149},{budget:3001},{budget:200.5},{owned:input.owned.slice(1)},
      {owned:[input.owned[0],input.owned[0],input.owned[2]]},{owned:changed('desk',{x:300})},
      {owned:changed('bookshelf',{x:-100})},{owned:changed('bookshelf',{rot:45})},
      {owned:changed('desk-chair',{locked:false})}]) await expect(service.createDesign({...input,...bad})).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });
  it('labels cached live searches independently from rules selection',async()=>{
    const {service,input,search}=fixture();
    search.mockImplementation(async(query,maxPrice)=>({ok:true,candidates:[],source:{query,maxPrice,resultIds:[],retrievedAt:at,cached:true,origin:'live'}}));
    const design=await service.createDesign(input);
    expect(design.labels).toEqual({search:'cached',ai:'rules'});
  });
});

it('searches with each slot cap rounded down to dollars and keeps expensive alternates',async()=>{
  const {service,input,search}=fixture({ai:true});
  const design=await service.createDesign({...input,budget:599});
  expect(search.mock.calls.map(c=>c[1])).toEqual([239,119,89,149]);
  expect(design.slots[0].pick?.id).toBe('small');
  expect(design.slots[0].alternates.map(a=>a.candidate.id)).toContain('large');
});
