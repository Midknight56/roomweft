import { afterEach, expect, it, vi } from 'vitest';
import { api, RequestError } from '../../src/client/api';

afterEach(()=>vi.unstubAllGlobals());
it('sends the brief only for a live design',async()=>{
  const fetcher=vi.fn().mockImplementation(async()=>Response.json({})); vi.stubGlobal('fetch',fetcher);
  await api.design('calm-studio',90000,[],true,'Evening reading');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({brief:'Evening reading',budget:900,live:true});
  await api.design('calm-studio',90000,[],false,'Evening reading');
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).not.toHaveProperty('brief');
});
it('keeps the stale quote and refreshed design from a checkout conflict',async()=>{
  const payload={code:'price_changed',error:'Prices changed at the shop. Freeze a new quote.',quote:{id:'quote',state:'stale',repriced:[{lineId:'floor-lamp',oldCents:8999,newCents:9999}]},design:{id:'room',version:2,totals:{totalCents:9999}}};
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(payload,{status:409})));
  const error=await api.checkout('quote','card').catch((error:unknown)=>error);
  expect(error).toBeInstanceOf(RequestError);
  expect(error).toMatchObject({code:payload.code,status:409,message:payload.error,quote:payload.quote,design:payload.design});
});
