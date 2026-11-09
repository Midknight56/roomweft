// The JSON shapes of every route. The Worker, the design service, the checkout service and the page all use these.
// Money is integer cents. Lengths are cm.
import type { FitReport, Rotation } from "./fit";
import type { Dimensions, RoomSpec, SlotId } from "./room";

export interface SourceRecord {
  query: string;
  maxPrice: number;
  resultIds: string[];
  /** ms since 1970, when Channel3 answered (a cache hit keeps the first time). */
  retrievedAt: number;
  cached: boolean;
  /** recorded = from the saved 6 Nov 2026 searches, not a new call. */
  origin: "live" | "recorded";
}

export interface Candidate {
  id: string;
  title: string;
  brand?: string;
  priceCents: number;
  currency: string;
  url: string;
  domain: string;
  image?: string;
  colors: string[];
  materials: string[];
  category?: string;
  dims: Dimensions | null;
  dimsRaw?: Record<string, unknown> | null;
  hasMeasurements?: boolean;
}

export interface Placement { x: number; z: number; rot: Rotation; moved?: true; nominal?: true }

export interface OwnedState { id: string; x: number; z: number; rot: Rotation; locked: boolean }

export interface AlternateView {
  candidate: Candidate;
  verified: boolean;
  fit: { passes: boolean; messages: string[] };
  priceDeltaCents: number;
}

export interface SlotView {
  slot: SlotId;
  pick: Candidate | null;
  by: "ai" | "rules" | "recorded" | "none";
  reason: string;
  placement: Placement | null;
  alternates: AlternateView[];
  source: SourceRecord | null;
  /** Set when a slot search failed or found nothing: the plain sentence to show. */
  note?: string;
  unavailable?: boolean;
}

export type DesignMode = "live" | "recorded" | "rules";

export interface DesignView {
  brief?: { text: string; understood: string; by: 'ai' | 'rules' | 'saved'; queries: Record<SlotId, string> };
  id: string;
  version: number;
  mode: DesignMode;
  style: string;
  budgetCents: number;
  owned: OwnedState[];
  slots: SlotView[];
  fit: FitReport;
  totals: { totalCents: number; budgetCents: number; overCents: number; unverifiedCount: number };
  labels: { search: "live" | "recorded" | "cached"; ai: "live" | "recorded" | "rules" };
  /** For recorded designs: when the searches were captured (ISO date). */
  capturedAt?: string;
  swapNote?: string;
  message?: string;
  /** The measured room. Missing on designs saved before measured rooms: they use DEFAULT_ROOM_SPEC. */
  roomSpec?: RoomSpec;
}

export interface QuoteLine {
  lineId: SlotId;
  roomObjectId: string;
  productId: string;
  title: string;
  priceCents: number;
  currency: "USD";
  url: string;
  domain: string;
  fitStatus: "fits" | "unverified";
  source: SourceRecord | null;
}

export type QuoteState =
  | "open" | "ordering" | "approving" | "capturing" | "capture_unknown" | "paid" | "declined" | "cancelled" | "stale" | "superseded";

export interface QuoteView {
  id: string;
  designId: string;
  designVersion: number;
  lines: QuoteLine[];
  totalCents: number;
  state: QuoteState;
  approveUrl?: string;
  error?: string;
  /** Lines whose price changed on recheck, when state is stale. */
  repriced?: { lineId: SlotId; oldCents: number; newCents: number | null }[];
  /** Set on a replacement quote: the earlier receipt and the refunded line it replaces. */
  replaces?: { quoteId: string; lineId: SlotId };
}

export type RefundState = "requesting" | "pending" | "completed" | "failed" | "unknown";

export interface RefundView {
  id: string;
  quoteId: string;
  lineId: string;
  amountCents: number;
  state: RefundState;
  paypalId: string | null;
}

export interface ReceiptView {
  quote: QuoteView;
  orderId: string | null;
  captureId: string | null;
  capturedCents: number;
  refundedCents: number;
  lines: (QuoteLine & { refund: { state: RefundState; amountCents: number; paypalId: string | null } | null })[];
  /** Room objects and how the plan stands against the receipt. */
  plan: { roomObjectId: string; productId: string; status: "paid" | "returned" }[];
  /** Live replacement quotes made for refunded lines of this receipt. */
  replacements?: { lineId: SlotId; quoteId: string; state: QuoteState }[];
  events: { type: string; receivedAt: number }[];
  recorded?: boolean;
  amountMismatch?: boolean;
}

export interface StatusView {
  search: { live: boolean; remainingToday: number };
  ai: { live: boolean; remainingNeuronsToday: number };
  sandbox: { live: boolean };
  visitor: { liveDesignsLeft: number; checkoutsLeft: number; refundsLeft: number };
  judgeLogin?: { email: string; password: string };
}

export interface ApiError { error: string; code: string; quote?: QuoteView; design?: DesignView }
