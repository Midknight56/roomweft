import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Channel3, mapProduct, mapProducts, takeCounter } from '../../src/products/channel3';
import { asD1, freshD1 } from './d1-fake';

const sample = JSON.parse(readFileSync('docs/research/channel3-sample-chair.json','utf8')) as {products: Record<string,unknown>[]};
const at=Date.UTC(2026,10,6,12);
const reply=(data:unknown,status=200,headers?:HeadersInit)=>new Response(JSON.stringify(data),{status,headers});
describe('product mapping',()=>{
  it('maps all five captured chairs with dimensions and cents',()=>{
    const candidates=mapProducts(sample);
    expect(candidates).toHaveLength(5);
    expect(candidates.every(c=>c.dims && Number.isInteger(c.priceCents) && c.colors.length<=3)).toBe(true);
    expect(candidates.some(c=>c.dims && Object.values(c.dims).some(n=>Math.round(n)===83))).toBe(true);
    expect(candidates.every(c=>c.dimsRaw!==null && c.url.startsWith('https:'))).toBe(true);
  });
  it('selects the cheapest new in stock USD https offer',()=>{
    const product=sample.products[0];
    const original=(product.offers as Record<string,unknown>[])[0];
    const offer=(price:number,extras:Record<string,unknown>={})=>({...original,price:{price,currency:'USD'},...extras});
    const mapped=mapProduct({...product,offers:[offer(1,{availability:'OutOfStock'}),offer(2,{condition:'used'}),
      offer(3,{price:{price:3,currency:'CAD'}}),offer(4,{url:'http://shop.example/chair'}),offer(12),offer(10)]});
    expect(mapped?.priceCents).toBe(1000);
    expect(mapProduct({...product,offers:[offer(1,{availability:'OutOfStock'}),offer(2,{condition:'used'})]})).toBeNull();
    expect(mapProduct({})).toBeNull();
  });
  it('does not guess missing or impossible dimensions',()=>{
    const product=sample.products[0], offer=(product.offers as Record<string,unknown>[])[0];
    expect(mapProduct({...product,offers:[{...offer,dimensions:null}]})?.dims).toBeNull();
    expect(mapProduct({...product,offers:[{...offer,dimensions:{width:{number:900,unit:'cm'}}}]})?.dims).toBeNull();
  });
});
describe('Channel3',()=>{
  it('uses the exact search contract and caches a normalized key for seven days',async()=>{
    const db=freshD1(), fetcher=vi.fn<typeof fetch>().mockResolvedValue(reply(sample));
    let now=at;
    const client=new Channel3({db:asD1(db),apiKey:'fake',fetch:fetcher,now:()=>now});
    const first=await client.search('  Reading   CHAIR ',600);
    now+=10000;
    const second=await client.search('reading chair',600);
    expect(second).toMatchObject({ok:true,source:{cached:true,retrievedAt:at}});
    expect(first).toMatchObject({ok:true,source:{cached:false,retrievedAt:at}});
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url,options]=fetcher.mock.calls[0];
    expect(url).toBe('https://api.trychannel3.com/v1/search');
    expect(options?.headers).toEqual({'x-api-key':'fake','Content-Type':'application/json'});
    expect(JSON.parse(String(options?.body))).toEqual({query:'reading chair',limit:8,filters:{price:{max_price:600}}});
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(db.sqlite.prepare('SELECT n FROM counters').get()).toMatchObject({n:1});
    expect(db.sqlite.prepare('SELECT expires_at FROM product_searches').get()).toMatchObject({expires_at:at+7*86400000});
  });
  it('expires searches and separates budget keys',async()=>{
    let now=at;
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>reply(sample));
    const client=new Channel3({db:asD1(freshD1()),apiKey:'fake',fetch:fetcher,now:()=>now});
    await client.search('chair',600); await client.search('chair',700);
    now+=7*86400000;
    expect(await client.search('chair',600)).toMatchObject({ok:true,source:{retrievedAt:now,cached:false}});
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('returns spent on 402 and errors on other unsuccessful responses',async()=>{
    for (const [status,reason] of [[402,'spent'],[500,'error']] as const) {
      const client=new Channel3({db:asD1(freshD1()),apiKey:'fake',fetch:vi.fn<typeof fetch>().mockResolvedValue(reply({},status))});
      expect(await client.search('chair',600)).toEqual({ok:false,reason});
    }
  });
  it('retries 429 once, caps delay at five seconds, and counts both calls',async()=>{
    const db=freshD1(), sleep=vi.fn().mockResolvedValue(undefined);
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(reply({},429,{'Retry-After':'30'})).mockResolvedValueOnce(reply(sample));
    const result=await new Channel3({db:asD1(db),apiKey:'fake',fetch:fetcher,sleep,now:()=>at}).search('chair',600);
    expect(result.ok).toBe(true); expect(sleep).toHaveBeenCalledWith(5000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(db.sqlite.prepare('SELECT n FROM counters').get()).toMatchObject({n:2});
    const twice=vi.fn<typeof fetch>().mockImplementation(async()=>reply({},429));
    expect(await new Channel3({db:asD1(freshD1()),apiKey:'fake',fetch:twice,sleep}).search('chair',600)).toEqual({ok:false,reason:'error'});
    expect(twice).toHaveBeenCalledTimes(2);
  });
  it('returns capped without fetching and resets on the next UTC day',async()=>{
    const db=freshD1();
    db.sqlite.prepare('INSERT INTO counters VALUES (?,?,?)').run('channel3','2026-11-06',300);
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(reply(sample));
    const client=new Channel3({db:asD1(db),apiKey:'fake',fetch:fetcher,now:()=>at});
    expect(await client.search('chair',600)).toEqual({ok:false,reason:'capped'});
    expect(fetcher).not.toHaveBeenCalled();
    expect(await takeCounter(asD1(db),'channel3',300,at+86400000)).toBe(true);
    expect(db.sqlite.prepare('SELECT n,day FROM counters').get()).toMatchObject({n:1,day:'2026-11-07'});
  });
  it('takes only the last available call under concurrent requests',async()=>{
    const db=freshD1();
    db.sqlite.prepare('INSERT INTO counters VALUES (?,?,?)').run('channel3','2026-11-06',299);
    expect(await Promise.all([takeCounter(asD1(db),'channel3',300,at),takeCounter(asD1(db),'channel3',300,at)])).toEqual([true,false]);
    expect(db.sqlite.prepare('SELECT n FROM counters').get()).toMatchObject({n:300});
  });
  it('fails closed on missing key, database failure and network error',async()=>{
    const db=freshD1(), fetcher=vi.fn<typeof fetch>();
    expect(await new Channel3({db:asD1(db),fetch:fetcher}).search('chair',600)).toEqual({ok:false,reason:'off'});
    db.broken=true;
    expect(await new Channel3({db:asD1(db),apiKey:'fake',fetch:fetcher}).search('chair',600)).toEqual({ok:false,reason:'error'});
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRejectedValue(new Error('offline'));
    expect(await new Channel3({db:asD1(freshD1()),apiKey:'fake',fetch:fetcher}).search('chair',600)).toEqual({ok:false,reason:'error'});
  });
  it('aborts a request at eight seconds',async()=>{
    vi.useFakeTimers();
    try {
      const fetcher=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>new Promise((_resolve,reject)=>
        init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')))));
      const pending=new Channel3({db:asD1(freshD1()),apiKey:'fake',fetch:fetcher}).search('chair',600);
      await vi.advanceTimersByTimeAsync(8000);
      expect(await pending).toEqual({ok:false,reason:'error'});
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('rechecks a product with a six hour cache and caches a gone product',async()=>{
    const db=freshD1(); let now=at;
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(reply(sample.products[0])).mockResolvedValueOnce(reply({},404));
    const client=new Channel3({db:asD1(db),apiKey:'fake',fetch:fetcher,now:()=>now});
    expect(await client.product('chair')).toMatchObject({ok:true,candidates:[{id:sample.products[0].id}]});
    now+=1;
    expect(await client.product('chair')).toMatchObject({ok:true,source:{cached:true,retrievedAt:at}});
    now=at+6*3600000;
    expect(await client.product('chair')).toMatchObject({ok:true,candidates:[],source:{cached:false}});
    expect(await client.product('chair')).toMatchObject({ok:true,candidates:[],source:{cached:true}});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.trychannel3.com/v1/products/chair');
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
  });
});
