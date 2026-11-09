import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignService, designLayout, type DesignInput } from '../../src/design/service';
import { CheckoutService } from '../../src/checkout/service';
import { harness, orderStep, unwrap } from './checkout-helper';
import { NeuronLedger } from '../../src/ai/ledger';
import { validatePicks, type PickBinding } from '../../src/ai/pick';
import { OWNED_ITEMS, SLOTS, STYLES, placeAtAnchor } from '../../src/shared/room';
import type { Candidate, DesignView } from '../../src/shared/api-types';
import type { ProductCandidate, SearchResult } from '../../src/products/channel3';
import { recordedPicks, recordedRuns } from '../../src/design/recorded';
import { asD1, freshD1, LEDGER_SQL } from './d1-fake';
import { makeRecordedData } from './recorded-fixture';
import { evaluateDesignFit } from '../../src/shared/fit';
import { layoutOf } from '../../src/client/helpers';
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
  it('reads a live brief before searching and carries its style and budget through the design',async()=>{
    const {service,input,run,search}=fixture({ai:true});
    run.mockResolvedValueOnce({response:{style:'night-desk',budget:700,words:{'reading-chair':['charcoal'],'floor-lamp':['tall']},understood:'Deep colours and a tall lamp suit evening reading.'}});
    const design=await service.createDesign({...input,brief:'I read in the evening'});
    expect(search).toHaveBeenCalledWith('charcoal reading chair',280);
    expect(search).toHaveBeenCalledWith('tall floor lamp',140);
    expect(design).toMatchObject({style:'night-desk',budgetCents:70000,brief:{by:'ai',queries:{'reading-chair':'charcoal reading chair'}}});
    expect((await service.get(design.id,input.visitorId)).brief).toEqual(design.brief);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('uses visitor settings and style queries after an invalid brief',async()=>{
    const {service,input,run,search}=fixture({ai:true});
    run.mockResolvedValueOnce({response:{style:'unlisted',budget:99999}});
    const design=await service.createDesign({...input,brief:'Evening reading'});
    expect(design).toMatchObject({style:input.style,budgetCents:60000,brief:{by:'rules',queries:STYLES[0].queries}});
    expect(search).toHaveBeenCalledWith(STYLES[0].queries['reading-chair'],240);
  });
  it('shows the recorded queries without a model call for a saved brief',async()=>{
    const {service,input,run,search}=fixture({ai:true});
    const design=await service.createDesign({...input,live:false,brief:'Evening reading'});
    expect(run).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled();
    expect(design.brief).toEqual({text:'Evening reading',by:'saved',understood:'Saved run: searched with the Warm reading corner words.',
      queries:Object.fromEntries(SLOTS.map(slot=>[slot.id,recordedRuns['warm-reading'].slots[slot.id].query]))});
  });
  it('does not read a brief after the live visitor counter is exhausted',async()=>{
    const {service,input,run}=fixture({ai:true});
    for (let i=0;i<3;i++) await service.createDesign(input);
    run.mockClear();
    const design=await service.createDesign({...input,brief:'Evening reading'});
    expect(design.brief?.by).toBe('saved'); expect(run).not.toHaveBeenCalled();
  });
  it('does not add a model call for an empty brief and labels an unavailable reader by rules',async()=>{
    const {service,input,run}=fixture({ai:true});
    await service.createDesign({...input,brief:'  \n '}); expect(run).toHaveBeenCalledOnce();
    const off=fixture();
    expect(await off.service.createDesign({...off.input,brief:'Evening reading'})).toMatchObject({brief:{by:'rules'}});
  });
  it('saves rechecked prices once and the next frozen checkout can proceed',async()=>{
    const {service,input,db}=fixture({unknown:true});
    const design=await service.createDesign(input);
    const slot=design.slots[0];
    slot.alternates.push({candidate:{...slot.pick!},verified:false,fit:{passes:true,messages:[]},priceDeltaCents:0});
    db.sqlite.prepare('UPDATE designs SET body=? WHERE id=?').run(JSON.stringify(design),design.id);
    const h=harness();
    const checkout=new CheckoutService({...h.options,db:asD1(db),designs:service});
    const quote=unwrap(await checkout.freezeQuote(design.id,design.version,'visitor'));
    const recheck=async()=>[{lineId:slot.slot,priceCents:20000}];
    const result=await checkout.startCheckout(quote.id,'visitor',{recheck});
    expect(result).toMatchObject({ok:false,code:'price_changed',quote:{state:'stale',repriced:[{oldCents:18600,newCents:20000}]},design:{version:2,totals:{totalCents:20000},fit:{budget:{total:20000,over:0}}}});
    const updated=await service.get(design.id,'visitor');
    expect(updated.slots[0].pick?.priceCents).toBe(20000);
    expect(updated.slots[0].alternates.find(a=>a.candidate.id===slot.pick!.id)?.candidate.priceCents).toBe(20000);
    const next=unwrap(await checkout.freezeQuote(design.id,updated.version,'visitor'));
    h.network.steps.push(orderStep());
    expect(await checkout.startCheckout(next.id,'visitor',{recheck})).toMatchObject({ok:true,value:{state:'approving',totalCents:20000}});
    expect((await service.get(design.id,'visitor')).version).toBe(2);
    await expect(service.get(design.id,'other')).rejects.toMatchObject({code:'not_found'});
  });
  it('blocks an unavailable pick through refresh until a different product is swapped in',async()=>{
    const {service,input,search}=fixture({unknown:true});
    search.mockResolvedValueOnce({ok:true,candidates:[{...small,dims:null},{...small,id:'replacement',dims:null}],source:{query:'chair',maxPrice:240,resultIds:['small','replacement'],retrievedAt:at,cached:false,origin:'live'}});
    const design=await service.createDesign(input);
    const h=harness();
    const checkout=new CheckoutService({...h.options,db:asD1(h.db),designs:service});
    const quote=unwrap(await checkout.freezeQuote(design.id,design.version,'visitor'));
    expect(await checkout.startCheckout(quote.id,'visitor',{recheck:async()=>[{lineId:'reading-chair',priceCents:null}]})).toMatchObject({ok:false,code:'price_changed',quote:{state:'stale'},design:{version:2,fit:{passes:false}}});
    let updated=await service.get(design.id,'visitor');
    expect(updated.slots[0]).toMatchObject({pick:design.slots[0].pick,unavailable:true,note:'No longer available at this shop. Swap for another.'});
    expect(updated.fit.messages.join(' ')).toContain('No longer available at this shop. Swap for another.');
    expect(await checkout.freezeQuote(design.id,updated.version,'visitor')).toMatchObject({ok:false,code:'fit_failed'});
    updated=await service.setLock(design.id,'visitor','bookshelf',true);
    expect(updated.fit.passes).toBe(false);
    await expect(service.swap(design.id,'visitor','reading-chair',design.slots[0].pick!.id)).rejects.toMatchObject({code:'invalid'});
    const alternate=updated.slots[0].alternates[0];
    expect(alternate.fit.passes).toBe(true);
    updated=await service.swap(design.id,'visitor','reading-chair',alternate.candidate.id);
    expect(updated.slots[0].unavailable).toBeUndefined(); expect(updated.slots[0].note).toBeUndefined();
    expect(unwrap(await checkout.freezeQuote(design.id,updated.version,'visitor')).state).toBe('open');
  });
  it('uses the existing budget failure after a shop price rise',async()=>{
    const {service,input}=fixture({unknown:true});
    const design=await service.createDesign(input);
    const updated=await service.applyPrices(design.id,'visitor',[{lineId:'reading-chair',oldCents:18600,newCents:61000}]);
    expect(updated).toMatchObject({version:2,totals:{totalCents:61000,overCents:1000},fit:{passes:false,budget:{total:61000,budget:60000,over:1000}}});
    expect(updated.fit.messages).toContain('The basket is over budget by $10.00.');
  });
  it('releases checkout ordering when the design price save fails',async()=>{
    const {service,input}=fixture({unknown:true});
    const design=await service.createDesign(input);
    const h=harness();
    const checkout=new CheckoutService({...h.options,designs:service});
    const quote=unwrap(await checkout.freezeQuote(design.id,design.version,'visitor'));
    vi.spyOn(service,'applyPrices').mockRejectedValueOnce(new Error('Save failed.'));
    await expect(checkout.startCheckout(quote.id,'visitor',{recheck:async()=>[{lineId:'reading-chair',priceCents:20000}]})).rejects.toThrow('Save failed.');
    expect(unwrap(await checkout.receipt(quote.id,'visitor')).quote.state).toBe('open');
    expect(h.network.payments()).toHaveLength(0);
  });
  it('rejects stale price updates without overwriting a newer swap',async()=>{
    const {service,input}=fixture({unknown:true});
    const design=await service.createDesign(input);
    await service.setLock(design.id,'visitor','bookshelf',true);
    await expect(service.applyPrices(design.id,'visitor',[{lineId:'reading-chair',oldCents:18600,newCents:20000}],design.version)).rejects.toMatchObject({code:'changed'});
    expect((await service.get(design.id,'visitor')).slots[0].pick?.priceCents).toBe(18600);
  });
  it.each(['recorded','live','cached'] as const)('repairs a stale rug in a %s list before verifying fit',async(origin)=>{
    const rug={...candidate('lorre',10,10,3000),dims:null,
      dimsRaw:{length:{number:84,unit:'in'},width:{number:60,unit:'in'},height:{number:0.4,unit:'in'}}};
    const {service,input,search}=fixture();
    recordedRuns[input.style as keyof typeof recordedRuns].slots.rug.candidates=[rug];
    if (origin!=='recorded') search.mockImplementation(async(query,maxPrice)=>({ok:true,
      candidates:query===STYLES[0].queries.rug?[rug]:[],
      source:{query,maxPrice,resultIds:[rug.id],retrievedAt:at,cached:origin==='cached',origin:'live'}}));
    const design=await service.createDesign({...input,live:origin!=='recorded'});
    expect(design.slots.find(slot=>slot.slot==='rug')?.pick).toMatchObject({id:'lorre',dims:{w:152.4,d:213.4,h:1},hasMeasurements:true});
    expect(designLayout(design).find(item=>item.id==='rug')?.dims).toBe('verified');
    expect(design.fit.unverified).not.toContain('rug');
  });
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
    expect(swapped.swapNote).toContain('fits through the 80 cm door');
    expect(swapped.swapNote).toContain('saves $54.00');
    expect(swapped.slots[0].alternates.map(a=>a.candidate.id)).toContain('large');
    expect(run).toHaveBeenCalledTimes(1);
    await expect(service.swap(initial.id,'visitor','reading-chair','foreign')).rejects.toThrow('Choose a product from this slot.');
  });
  it('adds fits through the door to the swap note when swapping from a tight pick to a not tight pick',async()=>{
    const {service,input}=fixture({ai:true});
    const initial=await service.createDesign(input);
    const swapped=await service.swap(initial.id,'visitor','reading-chair','small');
    expect(swapped.swapNote).toBe('Swapped for Jearey chair: 58 cm wide, clears the door swing by 18 cm, fits through the 80 cm door, saves $54.00.');
    const swappedBack=await service.swap(initial.id,'visitor','reading-chair','large');
    expect(swappedBack.swapNote).not.toContain('fits through the 80 cm door');
    expect(swappedBack.swapNote).toBe('Swapped for Large chair: 90 cm wide, blocks the door swing, adds $54.00.');
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
    const chair=design.slots.find(s=>s.slot==='reading-chair')!;
    expect(chair.pick).toBeNull(); expect(chair.note).toBe('Nothing under the $60 share for this piece. Raise the budget or swap.');
    const swapped=await service.swap(design.id,'visitor','reading-chair','expensive');
    expect(swapped.fit.budget.over).toBe(5000); expect(swapped.fit.passes).toBe(false);
    expect(swapped.totals).toMatchObject({totalCents:20000,overCents:5000,unverifiedCount:1});
    expect(swapped.swapNote).toContain('size unverified'); expect(swapped.swapNote).toContain('adds $200.00');
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
  it('saved fit equals shared evaluation on layoutOf for an unsized reading chair in the door swing', async () => {
    const { service, input } = fixture({ unknown: true });
    const design = await service.createDesign(input);
    const moved = await service.move(design.id, 'visitor', 'reading-chair', 250, 40, 0);
    const browserFit = evaluateDesignFit(layoutOf(moved), {
      prices: Object.fromEntries(moved.slots.map(s => [s.slot, s.pick?.priceCents ?? 0])),
      budget: moved.budgetCents,
      unavailable: moved.slots.filter(s => s.unavailable).map(s => s.slot),
    });
    expect(moved.fit.passes).toBe(browserFit.passes);
    expect(moved.fit.messages).toEqual(browserFit.messages);
    expect(moved.fit.unverified).toEqual(browserFit.unverified);
    expect(moved.fit.doorSwing).toEqual([]);
    expect(moved.fit.passes).toBe(true);
  });
  it('saved fit equals shared evaluation on layoutOf for an unsized floor lamp in the walkway', async () => {
    const { service, input, search } = fixture();
    search.mockImplementation(async (query, maxPrice) => {
      if (query === STYLES[0].queries['floor-lamp']) {
        return {
          ok: true,
          candidates: [{ ...small, id: 'lamp', kind: 'lamp', priceCents: 1000, dims: null }],
          source: { query, maxPrice, resultIds: ['lamp'], retrievedAt: at, cached: false, origin: 'live' },
        };
      }
      return {
        ok: true,
        candidates: query === STYLES[0].queries['reading-chair'] ? [small] : [],
        source: { query, maxPrice, resultIds: [], retrievedAt: at, cached: false, origin: 'live' },
      };
    });
    const design = await service.createDesign(input);
    const moved = await service.move(design.id, 'visitor', 'floor-lamp', 260, 70, 0);
    const browserFit = evaluateDesignFit(layoutOf(moved), {
      prices: Object.fromEntries(moved.slots.map(s => [s.slot, s.pick?.priceCents ?? 0])),
      budget: moved.budgetCents,
      unavailable: moved.slots.filter(s => s.unavailable).map(s => s.slot),
    });
    expect(moved.fit.passes).toBe(browserFit.passes);
    expect(moved.fit.messages).toEqual(browserFit.messages);
    expect(moved.fit.unverified).toEqual(browserFit.unverified);
    expect(moved.fit.walkway.reachable).toBe(true);
    expect(moved.fit.passes).toBe(true);
  });
  it('saved fit equals shared evaluation on layoutOf for an over budget unsized piece', async () => {
    const { service, input } = fixture({ unknown: true });
    const design = await service.createDesign(input);
    const repriced = await service.applyPrices(design.id, 'visitor', [{ lineId: 'reading-chair', oldCents: 18600, newCents: 70000 }]);
    const browserFit = evaluateDesignFit(layoutOf(repriced), {
      prices: Object.fromEntries(repriced.slots.map(s => [s.slot, s.pick?.priceCents ?? 0])),
      budget: repriced.budgetCents,
      unavailable: repriced.slots.filter(s => s.unavailable).map(s => s.slot),
    });
    expect(repriced.fit.passes).toBe(browserFit.passes);
    expect(repriced.fit.messages).toEqual(browserFit.messages);
    expect(repriced.fit.unverified).toEqual(browserFit.unverified);
    expect(repriced.fit.passes).toBe(false);
    expect(repriced.fit.budget.over).toBe(10000);
  });
});

it('searches with each slot cap rounded down to dollars and keeps expensive alternates',async()=>{
  const {service,input,search}=fixture({ai:true});
  const design=await service.createDesign({...input,budget:599});
  expect(search.mock.calls.map(c=>c[1])).toEqual([239,119,89,149]);
  expect(design.slots[0].pick?.id).toBe('small');
  expect(design.slots[0].alternates.map(a=>a.candidate.id)).toContain('large');
});
describe('measured rooms in the design service',()=>{
  const spec=async()=> (await import('../../src/shared/room')).DEFAULT_ROOM_SPEC;
  it('a 450 by 360 room clears the deep chair; a 300 by 280 room with the door near the corner blocks even the slim one',async()=>{
    const {service,input}=fixture({ai:true});
    const design=await service.createDesign(input);
    expect(design.fit.doorSwing).toContain('reading-chair');
    const big=await service.setRoom(design.id,'visitor',{...await spec(),width:450,depth:360});
    expect(big.version).toBe(2);
    expect(big.roomSpec).toMatchObject({width:450,depth:360});
    expect(big.fit.doorSwing).not.toContain('reading-chair');
    expect(big.fit.inside).toEqual([]);
    expect(big.slots[0].placement).toMatchObject({x:446-50,z:4+45});
    expect(big.owned.find(item=>item.id==='desk')).toMatchObject({x:450-10-60,z:360-5-30,locked:true});
    expect(await service.get(design.id,'visitor')).toEqual(big);
    const small=await service.setRoom(design.id,'visitor',{...await spec(),width:300,depth:280,door:{left:200,width:80}});
    expect(small.version).toBe(3);
    expect(small.fit.inside).toEqual([]);
    expect(small.fit.doorSwing).toContain('reading-chair');
    expect(small.slots[0].alternates.find(alt=>alt.candidate.id==='small')?.fit.passes).toBe(false);
    for (const item of designLayout(small)) {
      expect(item.x).toBeGreaterThan(0); expect(item.x).toBeLessThan(300); expect(item.z).toBeGreaterThan(0); expect(item.z).toBeLessThan(280);
    }
  });
  it('a room change after a quote is frozen makes that quote stale',async()=>{
    const {service,input,db}=fixture({ai:true});
    let design=await service.createDesign(input);
    design=await service.swap(design.id,'visitor','reading-chair','small');
    expect(design.fit.passes).toBe(true);
    const h=harness();
    const checkout=new CheckoutService({...h.options,db:asD1(db),designs:service});
    const quote=unwrap(await checkout.freezeQuote(design.id,design.version,'visitor'));
    await service.setRoom(design.id,'visitor',{...await spec(),width:450,depth:360});
    expect(await checkout.startCheckout(quote.id,'visitor')).toMatchObject({ok:false,code:'design_changed'});
  });
  it('refuses a bad room with its first error and keeps the design; a new design keeps a measured room',async()=>{
    const {service,input}=fixture({ai:true});
    const design=await service.createDesign(input);
    await expect(service.setRoom(design.id,'visitor',{...await spec(),width:100})).rejects.toMatchObject({code:'invalid',message:'Use a width from 200 to 800 cm.'});
    expect((await service.get(design.id,'visitor')).version).toBe(1);
    await expect(service.setRoom(design.id,'other',await spec())).rejects.toMatchObject({code:'not_found'});
    const {roomFromSpec}=await import('../../src/shared/room');
    const measured={...await spec(),width:450,depth:360};
    const owned=roomFromSpec(measured).ownedItems.map(i=>({id:i.id,x:i.x,z:i.z,rot:i.rot,locked:i.locked}));
    const next=await service.createDesign({...input,owned,roomSpec:measured});
    expect(next.roomSpec).toEqual(measured);
    expect(next.fit.doorSwing).not.toContain('reading-chair');
    await expect(service.createDesign({...input,roomSpec:measured})).rejects.toMatchObject({code:'invalid'});
  });
});
