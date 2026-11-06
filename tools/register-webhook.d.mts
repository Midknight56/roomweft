export const WEBHOOK_URL: string;
export const EVENT_TYPES: string[];
export function registerWebhook(options: { clientId?: string; secret?: string; fetcher?: typeof fetch }): Promise<string>;
