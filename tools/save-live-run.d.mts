export function saveLiveRuns(baseUrl: string, options?: { fetcher?: typeof fetch; root?: string; now?: () => number }): Promise<void>;
export function saveLiveRunCli(baseUrl?: string, options?: { fetcher?: typeof fetch; root?: string; now?: () => number }): Promise<number>;
