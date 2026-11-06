import type { Candidate } from '../shared/api-types';
import { slotCapCents, type SlotId, type Style } from '../shared/room';
export function eligibleCandidates(budgetCents: number, slot: SlotId, candidates: readonly Candidate[]): Candidate[] {
  const eligible = candidates.filter(c => c.priceCents <= slotCapCents(budgetCents, slot));
  if (eligible.length) return slot !== 'rug' && eligible.some(c => c.dims) ? eligible.filter(c => c.dims) : eligible;
  return [...candidates].sort((a,b) => a.priceCents-b.priceCents || a.id.localeCompare(b.id)).slice(0,1);
}
const materials = { 'warm-reading': ['wood','oak','walnut','linen','wool','boucle'], 'calm-studio': ['oak','ash','white','cotton','jute'], 'night-desk': ['metal','black','walnut','velvet','brass'] };
function distance(a: string, b: string): number {
  const rgb = (hex: string) => [1,3,5].map(i => parseInt(hex.slice(i,i+2),16));
  return Math.sqrt(rgb(a).reduce((n,c,i) => n + (c-rgb(b)[i])**2,0));
}
export function rulesPick(style: Style, budgetCents: number, slot: SlotId, candidates: readonly Candidate[]): Candidate | null {
  const score = (c: Candidate): number => {
    const colours = c.colors.filter(hex => /^#[\da-f]{6}$/i.test(hex));
    const closeness = colours.length ? 1 - Math.min(...colours.flatMap(hex => Object.values(style.palette).map(p => distance(hex,p)))) / 442 : 0;
    return Number(c.dims !== null) * 2 + closeness
      + materials[style.id].filter(word => c.materials.some(m => m.toLowerCase().includes(word))).length;
  };
  return eligibleCandidates(budgetCents,slot,candidates).sort((a,b) => score(b)-score(a) || a.priceCents-b.priceCents || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}

export function rulesReason(style: Style, budgetCents: number, slot: SlotId, candidate: Candidate): string {
  const cap = slotCapCents(budgetCents, slot);
  const money = `$${Number((cap / 100).toFixed(2))}`;
  const budget = candidate.priceCents <= cap ? `Under the ${money} share for this piece.` : `Lowest price available. Above the ${money} share for this piece.`;
  const matched = materials[style.id].filter(word => candidate.materials.some(m => m.toLowerCase().includes(word))).slice(0,2);
  const words = matched.join(' and ');
  return `${budget} ${words ? words[0].toUpperCase() + words.slice(1) + (matched.length === 1 ? ' matches' : ' match') + ' the style.' : 'Closest colours to the style.'}`;
}
