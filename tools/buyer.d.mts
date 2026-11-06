export class BuyerChallenge extends Error {}
export function sandboxApproveUrl(value: string): string;
interface BuyerLocator {
  count(): Promise<number>;
  innerText(): Promise<string>;
  all(): Promise<BuyerLocator[]>;
  isVisible(options?: { timeout?: number }): Promise<boolean>;
  waitFor(options: { state: 'visible' | 'hidden'; timeout?: number }): Promise<void>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  isEnabled(): Promise<boolean>;
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  first(): BuyerLocator;
}
export interface BuyerPage {
  goto(url: string, options?: { waitUntil?: 'domcontentloaded' }): Promise<unknown>;
  waitForLoadState(state: 'domcontentloaded'): Promise<void>;
  waitForURL(predicate: (url: URL) => boolean, options: { timeout: number }): Promise<void>;
  url(): string;
  locator(selector: string): BuyerLocator;
}
export function hasChallenge(page: BuyerPage): Promise<boolean>;
export function approveBuyer(page: BuyerPage, approveUrl: string, options?: { email?: string; password?: string }): Promise<string>;
