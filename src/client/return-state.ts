declare global { interface Window { __roomweftReady: boolean } }

export function checkoutReturn(href: string): { receiptId: string | null; message: string; cleanUrl: string; present: boolean } {
  const url = new URL(href);
  const receiptId = url.searchParams.get('receipt');
  const checkout = url.searchParams.get('checkout');
  const defaults: Record<string, string> = { cancelled: 'Payment was cancelled.', declined: 'Payment was declined.', stale: 'The design changed. Freeze a new quote.', changed: 'The design changed. Freeze a new quote.' };
  const message = checkout ? url.searchParams.get('message') || defaults[checkout] || 'Please review your basket before paying.' : '';
  const present = ['receipt', 'checkout', 'message'].some(key => url.searchParams.has(key));
  for (const key of ['receipt', 'checkout', 'message']) url.searchParams.delete(key);
  return { receiptId, message, cleanUrl: `${url.pathname}${url.search}${url.hash}`, present };
}

export class FrameReadiness {
  private version = 0;
  private loaded = false;
  constructor(private readonly publish: (ready: boolean) => void) { publish(false); }
  loading(): number { this.loaded = false; this.publish(false); return ++this.version; }
  loadedDesign(version: number): void { if (version === this.version) this.loaded = true; }
  drawn(): void { if (this.loaded) this.publish(true); }
}
