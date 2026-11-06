// Free search credits only, no card: 300 app requests and three live designs per visitor each UTC day.
// Model calls reserve 10 neurons in the shared ledger. The account stays inside its free allowance.
// Sandbox checkouts and refunds move no real money. Six of each keeps sandbox use bounded. Cost: $0.
export const LIVE_DESIGNS_PER_DAY = 3;
export const CHECKOUTS_PER_DAY = 6;
export const REFUNDS_PER_DAY = 6;
export const SEARCHES_PER_DAY = 300;
export const BODY_LIMIT = 16 * 1024;
export const PRICE_MAX_AGE = 6 * 60 * 60 * 1000;
