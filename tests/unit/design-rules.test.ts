import { describe, expect, it } from 'vitest';
import { rulesPick, eligibleCandidates, rulesReason } from '../../src/design/rules';
import { STYLES } from '../../src/shared/room';
import type { Candidate } from '../../src/shared/api-types';
const c=(id:string,changes:Partial<Candidate>={}):Candidate=>({id,title:id,priceCents:10000,currency:'USD',url:'https://shop.example/item',domain:'shop.example',colors:[],materials:[],dims:null,...changes});
describe('rules picks',()=>{
  it.each(['reading-chair','floor-lamp','side-table'] as const)('keeps only sized eligible %s candidates',slot=>{
    const unknown=c('unknown',{materials:['oak','linen','wool','boucle']});
    const sized=c('sized',{dims:{w:50,d:50,h:80}});
    expect(eligibleCandidates(90000,slot,[unknown,sized])).toEqual([sized]);
    expect(rulesPick(STYLES[0],90000,slot,[unknown,sized])).toEqual(sized);
    expect(eligibleCandidates(90000,slot,[unknown,{...sized,priceCents:100000}])).toEqual([unknown]);
  });
  it('retains unsized rugs alongside sized rugs',()=>{
    const rug=c('rug'), sized=c('sized',{dims:{w:150,d:210,h:1}});
    expect(eligibleCandidates(90000,'rug',[rug,sized])).toEqual([rug,sized]);
  });
  it('scores slot budget share, dimensions, palette and style materials',()=>{
    const style=STYLES[0];
    expect(rulesPick(style,60000,'reading-chair',[c('over',{priceCents:25000}),c('within',{priceCents:24000})])?.id).toBe('within');
    expect(rulesPick(style,60000,'floor-lamp',[c('over',{priceCents:13000}),c('within',{priceCents:12000})])?.id).toBe('within');
    expect(rulesPick(style,60000,'side-table',[c('over',{priceCents:10000}),c('within',{priceCents:9000})])?.id).toBe('within');
    expect(rulesPick(style,60000,'rug',[c('over',{priceCents:16000}),c('within',{priceCents:15000})])?.id).toBe('within');
    expect(rulesPick(style,60000,'reading-chair',[c('unknown'),c('known',{dims:{w:58,d:58,h:72}})])?.id).toBe('known');
    expect(rulesPick(style,60000,'reading-chair',[c('a',{colors:['#0000ff']}),c('b',{colors:[style.palette.accent]})])?.id).toBe('b');
    for (const [s,material] of [[STYLES[0],'Walnut'],[STYLES[1],'Ash'],[STYLES[2],'Brass']] as const)
      expect(rulesPick(s,60000,'reading-chair',[c('a'),c('b',{materials:[material]})])?.id).toBe('b');
  });
  it('breaks ties by price then id and accepts empty lists',()=>{
    expect(rulesPick(STYLES[0],60000,'reading-chair',[c('b'),c('a'),c('c',{priceCents:9000})])?.id).toBe('c');
    expect(rulesPick(STYLES[0],60000,'reading-chair',[c('b'),c('a')])?.id).toBe('a');
    expect(rulesPick(STYLES[0],60000,'reading-chair',[])).toBeNull();
  });
});

it('filters strictly by cap and falls back to one cheapest candidate', () => {
  const cheap=c('cheap',{priceCents:20000}); const expensive=c('expensive',{priceCents:30000,materials:['oak','linen'],dims:{w:50,d:50,h:80}});
  expect(eligibleCandidates(60000,'reading-chair',[expensive,cheap])).toEqual([cheap]);
  expect(rulesPick(STYLES[0],60000,'reading-chair',[expensive,cheap])).toEqual(cheap);
  expect(eligibleCandidates(15000,'reading-chair',[expensive,cheap])).toEqual([cheap]);
  expect(eligibleCandidates(15000,'reading-chair',[])).toEqual([]);
});
it('explains the actual share and at most two matching materials', () => {
  expect(rulesReason(STYLES[1],90000,'side-table',c('table',{materials:['oak']}))).toBe('Under the $135 share for this piece. Oak matches the style.');
  expect(rulesReason(STYLES[0],90000,'side-table',c('table',{materials:['oak','linen','wool']}))).toContain('Oak and linen match the style.');
  expect(rulesReason(STYLES[0],15000,'side-table',c('table'))).toBe('Lowest price available. Above the $22.5 share for this piece. Closest colours to the style.');
});
