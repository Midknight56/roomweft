import type { Candidate, DesignView, OwnedState, Placement, SlotView } from '../shared/api-types';
import { checkFit, footprintBounds, moveItem, type Footprint, type Rotation } from '../shared/fit';
import { DOOR, NOMINAL_DIMS, OWNED_ITEMS, ROOM, SLOTS, STYLES, WINDOW, slotCapCents, placeAtAnchor, type SlotId } from '../shared/room';
import { takeCounter, type SearchResult } from '../products/channel3';
import { pick, validatePicks, type CandidateLists, type PickBinding } from '../ai/pick';
import type { NeuronLedger } from '../ai/ledger';
import { recordedPicks, recordedRuns } from './recorded';
import { rulesPick, rulesReason } from './rules';
import { object } from '../products/channel3';

export interface DesignInput { style: string; budget: number; owned: OwnedState[]; live: boolean; visitorId: string }
export interface DesignOptions {
  db: D1Database; search: {search(query:string,maxPrice:number):Promise<SearchResult>};
  ledger: NeuronLedger; ai?: PickBinding; now?: () => number; id?: () => string;
}
export class DesignError extends Error {
  constructor(public code: 'invalid' | 'not_found' | 'changed', message: string) { super(message); }
}
const invalid = (message: string): never => { throw new DesignError('invalid',message); };
function ownedLayout(states: OwnedState[]): Footprint[] {
  return states.map(state => {
    const item = OWNED_ITEMS.find(i => i.id === state.id)!;
    return {...item,...state,source:'owned',dims:'verified'};
  });
}
function slotFootprint(slot: SlotView): Footprint | null {
  if (!slot.pick || !slot.placement) return null;
  const dims = slot.pick.dims ?? NOMINAL_DIMS[slot.slot];
  return {id:slot.slot,label:SLOTS.find(s=>s.id===slot.slot)!.label,kind:SLOTS.find(s=>s.id===slot.slot)!.kind,
    ...dims,...slot.placement,locked:false,movable:true,source:'slot',dims:slot.pick.dims ? 'verified' : 'unverified'};
}
export function designLayout(design: DesignView): Footprint[] {
  return [...ownedLayout(design.owned),...design.slots.map(slotFootprint).filter((p):p is Footprint=>p!==null)];
}
function fitDesign(design: DesignView): DesignView['fit'] {
  const layout = designLayout(design);
  // Unknown dimensions cannot be geometric obstacles. Keep them explicitly unverified.
  const fit = checkFit(layout.filter(p=>p.dims==='verified'),ROOM,DOOR,WINDOW,
    {prices:Object.fromEntries(design.slots.map(s=>[s.slot,s.pick?.priceCents ?? 0])),budget:design.budgetCents});
  const total = design.slots.reduce((n,s)=>n+(s.pick?.priceCents ?? 0),0);
  fit.budget = {total,budget:design.budgetCents,over:Math.max(0,total-design.budgetCents)};
  fit.unverified = layout.filter(p=>p.dims==='unverified').map(p=>p.id);
  fit.messages = fit.messages.filter(m=>!m.startsWith('The basket is over budget'));
  if (fit.budget.over) fit.messages.push(`The basket is over budget by $${(fit.budget.over/100).toFixed(2)}.`);
  for (const id of fit.unverified) fit.messages.push(`The ${SLOTS.find(s=>s.id===id)!.label} has unverified dimensions.`);
  fit.passes = fit.passes && fit.budget.over === 0;
  return fit;
}
function placementFor(design: DesignView, slot: SlotView, candidate: Candidate): Placement {
  const placed = designLayout(design).filter(p=>p.id!==slot.slot);
  // Side tables require a chair anchor even when its search found nothing.
  if (slot.slot==='side-table' && !placed.some(p=>p.id==='reading-chair')) {
    placed.push({id:'reading-chair',label:'Reading chair',kind:'chair',...NOMINAL_DIMS['reading-chair'],
      ...placeAtAnchor(SLOTS[0],NOMINAL_DIMS['reading-chair'],placed),locked:false,source:'slot',dims:'unverified',nominal:true});
  }
  return {...placeAtAnchor(SLOTS.find(s=>s.id===slot.slot)!,candidate.dims ?? NOMINAL_DIMS[slot.slot],placed),
    ...(!candidate.dims ? {nominal:true as const} : {})};
}
function placeCandidate(design: DesignView, slot: SlotView, candidate: Candidate): void {
  slot.pick = candidate;
  if (!slot.placement?.moved) slot.placement = placementFor(design,slot,candidate);
  else {
    const {nominal: _nominal, ...position} = slot.placement;
    slot.placement = {...position,...(!candidate.dims ? {nominal:true as const} : {})};
  }
  const pending: string[] = [slot.slot];
  const visited = new Set<string>();
  for (let index=0; index<pending.length; index++) {
    const parent = pending[index];
    if (visited.has(parent)) continue;
    visited.add(parent);
    for (const follower of design.slots) {
      const anchor = SLOTS.find(s=>s.id===follower.slot)!.anchor;
      if (anchor.kind!=='beside' || anchor.followsId!==parent) continue;
      if (follower.pick && !follower.placement?.moved) follower.placement = placementFor(design,follower,follower.pick);
      pending.push(follower.slot);
    }
  }
}
function refresh(design: DesignView): void {
  design.fit = fitDesign(design);
  design.totals = {totalCents:design.fit.budget.total,budgetCents:design.budgetCents,overCents:design.fit.budget.over,unverifiedCount:design.fit.unverified.length};
  for (const slot of design.slots) for (const alt of slot.alternates) {
    const previousPick = slot.pick;
    const placements = design.slots.map(s=>s.placement);
    placeCandidate(design,slot,alt.candidate);
    const fit = fitDesign(design);
    alt.fit = {passes:fit.passes,messages:fit.messages};
    alt.verified = alt.candidate.dims !== null;
    alt.priceDeltaCents = alt.candidate.priceCents - (previousPick?.priceCents ?? 0);
    slot.pick = previousPick;
    design.slots.forEach((s,index)=>{ s.placement=placements[index]; });
  }
}
export class DesignService {
  private now: () => number;
  constructor(private options: DesignOptions) { this.now=options.now ?? Date.now; }
  async createDesign(input: DesignInput): Promise<DesignView> {
    const style = STYLES.find(s=>s.id===input.style);
    if (!style) return invalid('Choose a known style.');
    if (!Number.isInteger(input.budget) || input.budget<150 || input.budget>3000) return invalid('Use a whole dollar budget from 150 to 3000.');
    if (typeof input.live!=='boolean' || typeof input.visitorId!=='string' || !input.visitorId.trim()) return invalid('Use a valid visitor and search choice.');
    if (!Array.isArray(input.owned) || input.owned.length!==OWNED_ITEMS.length || input.owned.some(i=>!i || typeof i!=='object')
      || new Set(input.owned.map(i=>i.id)).size!==OWNED_ITEMS.length) return invalid('Include each owned item once.');
    for (const state of input.owned) {
      const def=OWNED_ITEMS.find(i=>i.id===state.id);
      if (!def || ![state.x,state.z].every(Number.isFinite) || ![0,90,180,270].includes(state.rot) || typeof state.locked!=='boolean') return invalid('Use valid owned items and positions.');
      if (state.locked && (state.x!==def.x || state.z!==def.z || state.rot!==def.rot)) return invalid('Keep locked items at their default place.');
    }
    const desk=input.owned.find(i=>i.id==='desk')!, chair=input.owned.find(i=>i.id==='desk-chair')!;
    if (desk.locked!==chair.locked) return invalid('The desk and desk chair share one lock.');
    if (checkFit(ownedLayout(input.owned),ROOM,DOOR,WINDOW).inside.length) return invalid('Keep owned items inside the room.');
    const recorded=recordedRuns[style.id];
    let live=false;
    if (input.live) { try { live=await takeCounter(this.options.db,`design:${input.visitorId}`,3,this.now()); } catch { /* Recorded fallback. */ } }
    const lists = {} as CandidateLists;
    const slots: SlotView[]=[];
    for (const slot of SLOTS) {
      let result: SearchResult={ok:false,reason:'off'};
      if (live) { try { result=await this.options.search.search(style.queries[slot.id],Math.floor(slotCapCents(input.budget*100,slot.id)/100)); } catch { result={ok:false,reason:'error'}; } }
      const rec=recorded.slots[slot.id];
      lists[slot.id]=result.ok ? result.candidates : rec.candidates;
      slots.push({slot:slot.id,pick:null,by:'none',reason:'',placement:null,alternates:[],source:result.ok ? result.source :
        {query:rec.query,maxPrice:rec.maxPrice,resultIds:rec.resultIds,retrievedAt:rec.retrievedAt,cached:false,origin:'recorded'},
        ...(!result.ok && live ? {note:`Live search is ${result.reason}. This slot uses recorded products.`} : {}),
        ...(result.ok && !result.candidates.length ? {note:'No products were found for this slot.'} : {})});
    }
    const hasLive=slots.some(s=>s.source?.origin==='live');
    const pickInput={style,budgetCents:input.budget*100,candidates:lists};
    const response=hasLive ? await pick(pickInput,this.options.ai,this.options.ledger) : null;
    const stored=recordedPicks[style.id];
    const savedPicks=!hasLive && stored ? validatePicks({picks:Array.isArray(stored.picks)
      ? stored.picks.filter(entry=>object(entry).by==='ai') : []},pickInput) : [];
    for (const slot of slots) {
      const chosen=response?.ok ? response.picks.find(p=>p.slot===slot.slot) : savedPicks.find(p=>p.slot===slot.slot);
      slot.pick=lists[slot.slot].find(c=>c.id===chosen?.id) ?? rulesPick(style,input.budget*100,slot.slot,lists[slot.slot]);
      slot.by=!slot.pick ? 'none' : slot.source?.origin==='recorded' ? 'recorded' : chosen?.by ?? 'rules';
      slot.reason=slot.pick ? chosen?.reason ?? rulesReason(style,input.budget*100,slot.slot,slot.pick) : 'No product is available.';
      slot.alternates=lists[slot.slot].filter(c=>c.id!==slot.pick?.id).map(candidate=>({candidate,verified:candidate.dims!==null,fit:{passes:false,messages:[]},priceDeltaCents:0}));
    }
    const design: DesignView={id:(this.options.id ?? (()=>crypto.randomUUID()))(),version:1,mode:!hasLive?'recorded':response?.ok && response.picks.some(p=>p.by==='ai')?'live':'rules',
      style:style.id,budgetCents:input.budget*100,owned:input.owned.map(i=>({...i})),slots,
      fit:checkFit([],ROOM,DOOR,WINDOW),totals:{totalCents:0,budgetCents:input.budget*100,overCents:0,unverifiedCount:0},
      labels:{search:!hasLive?'recorded':slots.filter(s=>s.source?.origin==='live').every(s=>s.source?.cached)?'cached':'live',ai:!hasLive && savedPicks.some(p=>p.by==='ai')?'recorded':response?.ok && response.picks.some(p=>p.by==='ai')?'live':'rules'},
      ...(!hasLive?{capturedAt:recorded.capturedAt}:{})};
    for (const slot of slots) if (slot.pick) slot.placement=placementFor(design,slot,slot.pick);
    refresh(design);
    const now=this.now();
    await this.options.db.prepare('INSERT INTO designs (id,visitor,version,body,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .bind(design.id,input.visitorId,1,JSON.stringify(design),now,now).run();
    return design;
  }
  async get(designId:string,visitor:string):Promise<DesignView> {
    const row=await this.options.db.prepare('SELECT body FROM designs WHERE id=? AND visitor=?').bind(designId,visitor).first<{body:string}>();
    if (!row) throw new DesignError('not_found','not found');
    return JSON.parse(row.body) as DesignView;
  }
  private async save(design:DesignView,visitor:string,version:number):Promise<DesignView> {
    design.version=version+1; refresh(design);
    const result=await this.options.db.prepare('UPDATE designs SET version=?,body=?,updated_at=? WHERE id=? AND visitor=? AND version=?')
      .bind(design.version,JSON.stringify(design),this.now(),design.id,visitor,version).run();
    if (result.meta.changes!==1) throw new DesignError('changed','changed, reload');
    return design;
  }
  async swap(designId:string,visitor:string,slotId:SlotId,productId:string):Promise<DesignView> {
    const design=await this.get(designId,visitor), version=design.version;
    const slot=design.slots.find(s=>s.slot===slotId);
    if (!slot) return invalid('Choose a known slot.');
    const candidates=[...(slot.pick?[slot.pick]:[]),...slot.alternates.map(a=>a.candidate)];
    const candidate=candidates.find(c=>c.id===productId);
    if (!candidate) return invalid('Choose a product from this slot.');
    const difference=candidate.priceCents-(slot.pick?.priceCents ?? 0);
    placeCandidate(design,slot,candidate); slot.by='rules';
    slot.alternates=candidates.filter(c=>c.id!==productId).map(c=>({candidate:c,verified:c.dims!==null,fit:{passes:false,messages:[]},priceDeltaCents:0}));
    const width=candidate.dims ? `${candidate.dims.w} cm wide` : 'size unverified';
    const box=slotFootprint(slot);
    const bounds=box ? footprintBounds(box) : null;
    const clearance=bounds && candidate.dims ? doorClearance(bounds) : null;
    const blocksDoor=fitDesign(design).doorSwing.includes(slotId);
    const doorText=slotId==='rug' ? '' : clearance===null ? '' : blocksDoor ? ', blocks the door swing' : `, clears the door swing by ${Math.floor(clearance)} cm`;
    design.swapNote=`Swapped for ${candidate.title}: ${width}${doorText}, ${difference<=0?'saves':'adds'} $${(Math.abs(difference)/100).toFixed(2)}.`;
    slot.reason=design.swapNote;
    return this.save(design,visitor,version);
  }
  async move(designId:string,visitor:string,itemId:string,x:number,z:number,rot:Rotation):Promise<DesignView> {
    const design=await this.get(designId,visitor), version=design.version;
    const layout=designLayout(design), item=layout.find(i=>i.id===itemId);
    if (item?.locked) return invalid(`The ${itemId==='desk' || itemId==='desk-chair'?'desk':item.label.toLowerCase()} is locked. Unlock it first.`);
    const moved=moveItem(layout,itemId,x,z,rot);
    if ('error' in moved) return invalid(moved.error);
    design.owned=design.owned.map(o=>({...o,...position(moved.find(i=>i.id===o.id)!)}));
    for (const slot of design.slots) {
      const next=moved.find(i=>i.id===slot.slot);
      if (next) slot.placement={...slot.placement,...position(next),...(slot.slot===itemId ? {moved:true as const} : {})};
    }
    return this.save(design,visitor,version);
  }
  async setLock(designId:string,visitor:string,itemId:string,locked:boolean):Promise<DesignView> {
    const design=await this.get(designId,visitor),version=design.version;
    if (typeof locked!=='boolean' || !design.owned.some(i=>i.id===itemId)) return invalid('Choose an owned item and a valid lock.');
    for (const item of design.owned) if (item.id===itemId || (['desk','desk-chair'].includes(itemId) && ['desk','desk-chair'].includes(item.id))) item.locked=locked;
    return this.save(design,visitor,version);
  }
}
function position(item:Footprint):Placement { return {x:item.x,z:item.z,rot:item.rot}; }
function doorClearance(bounds: ReturnType<typeof footprintBounds>):number {
  const x=bounds.minX-DOOR.hinge.x, z=bounds.minZ-DOOR.hinge.z;
  const farX=bounds.maxX-DOOR.hinge.x, farZ=bounds.maxZ-DOOR.hinge.z;
  if (farX<0 && farZ<0) return Math.hypot(farX,farZ);
  if (farX<0) return Math.hypot(farX,Math.max(0,z-DOOR.radius));
  if (farZ<0) return Math.hypot(Math.max(0,x-DOOR.radius),farZ);
  return Math.max(0,Math.hypot(Math.max(0,x),Math.max(0,z))-DOOR.radius);
}
