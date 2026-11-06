import type { Candidate } from '../../src/shared/api-types';
import type { RecordedRun } from '../../src/design/recorded';
import { SLOTS, STYLES } from '../../src/shared/room';

export function fixtureCandidate(id: string, materials: string[] = ['linen']): Candidate {
  return {id,title:'Quiet accent piece',brand:'Home workshop',priceCents:3000,currency:'USD',
    url:'https://shop.example/piece',domain:'shop.example',colors:['#998855'],materials,dims:{w:40,d:40,h:60}};
}

export function makeRecordedData() {
  const at=Date.UTC(2026,10,6,12);
  const recordedRuns=Object.fromEntries(STYLES.map(style=>[style.id,{
    style:style.id,capturedAt:new Date(at).toISOString(),
    slots:Object.fromEntries(SLOTS.map(slot=>{
      const candidates=[fixtureCandidate(`${slot.id}-first`),fixtureCandidate(`${slot.id}-second`)];
      return [slot.id,{query:style.queries[slot.id],maxPrice:100,resultIds:candidates.map(c=>c.id),retrievedAt:at,candidates}];
    })),
  }])) as Record<typeof STYLES[number]['id'],RecordedRun>;
  const recordedPicks: Partial<Record<typeof STYLES[number]['id'],{picks:unknown;neurons:number;at:string}>>={};
  return {recordedRuns,recordedPicks};
}
