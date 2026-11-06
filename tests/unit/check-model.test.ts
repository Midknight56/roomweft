import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkModel } from '../../tools/check-model.mjs';
import { MODEL } from '../../src/ai/pick';

afterEach(()=>vi.restoreAllMocks());
describe('model page check',()=>{
  it.each([
    ['<h1>Granite</h1><p>Function calling Yes</p>',0],
    ['<p>Planned Deprecation 11/20/2026</p>',1],
    ['<p>Deprecated</p>',1],
    ['<p>planned <strong>deprecation</strong></p>',1],
  ])('checks page text %s',async(page,code)=>{
    const log=vi.spyOn(console,'log').mockImplementation(()=>{});
    const error=vi.spyOn(console,'error').mockImplementation(()=>{});
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(page));
    expect(await checkModel(fetcher)).toBe(code);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://developers.cloudflare.com/workers-ai/models/${MODEL.split('/').at(-1)}/`);
    expect(code===0?log:error).toHaveBeenCalledOnce();
  });
  it.each(['http','network','body'])('fails closed on %s errors',async(kind)=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const fetcher=vi.fn<typeof fetch>();
    if (kind==='network') fetcher.mockRejectedValue(new Error('offline'));
    else if (kind==='body') {
      const response=new Response('');
      vi.spyOn(response,'text').mockRejectedValue(new Error('read failed'));
      fetcher.mockResolvedValue(response);
    }
    else fetcher.mockResolvedValue(new Response('Unavailable',{status:503}));
    expect(await checkModel(fetcher)).toBe(1);
  });
});
