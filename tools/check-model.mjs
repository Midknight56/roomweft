import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkModel(fetcher = fetch) {
  try {
    const source = await readFile(new URL('../src/ai/pick.ts', import.meta.url), 'utf8');
    const model = source.match(/export const MODEL = '(@cf\/[^']+)';/)?.[1];
    if (!model) throw new Error('Missing model configuration.');
    const name = model.split('/').at(-1);
    const url = `https://developers.cloudflare.com/workers-ai/models/${name}/`;
    const response = await fetcher(url);
    if (!response.ok) throw new Error('Model page is unavailable.');
    const page = (await response.text()).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ');
    if (/planned\s+deprecation|\bdeprecated\b/i.test(page)) {
      console.error(`${model}: deprecation notice found. ${url}`);
      return 1;
    }
    console.log(`${model}: no deprecation notice found. ${url}`);
    return 0;
  } catch {
    console.error('Could not check the configured model page.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await checkModel();
}
