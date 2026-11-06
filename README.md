# RoomWeft

Keep the furniture you own. RoomWeft fits the missing pieces around it, checks the door swing, the walkway and your
budget, lets you walk through the room in 3D, and then you pay for the basket in one PayPal sandbox checkout.

Live: https://roomweft.midknight-labs.workers.dev

## For judges

No login is needed for RoomWeft itself. The PayPal step uses a PayPal sandbox buyer (test money only). Its email and
password are shown in the "For judges" box at the bottom of the page.

The 60 second path:

1. Open the page. A furnished room loads from a recorded run. Pick the Calm studio style.
2. Your desk is locked in place. Lower the budget, or press "Search live" for a new design from live product search.
3. A chair that blocks the door swing shows a red region. Press "Swap for one that fits", then press Walk and move
   through the room with W, A, S and D (on a phone, drag).
4. Freeze the quote and pay with PayPal (sandbox). Back on RoomWeft, every receipt line is tied to an object in the
   room. Refund one item and watch the plan and the receipt part ways.

What is real and what is not:

| Part | Real or simulated |
| --- | --- |
| Product search | Real Channel3 API calls. Saved searches from 6 Nov 2026 are used when a daily cap is reached, and the page says so |
| Sizes | From the retailer listing through Channel3. A missing size is shown as "fit unverified", never guessed |
| 3D furniture | Visual approximations scaled to the real size, not the exact product model |
| Fit checks | Done in code: walls, overlaps, door swing, a 76 cm walkway, budget |
| Model picks | Workers AI picks a candidate per slot for taste and writes a short reason. Code checks every pick |
| Payment | Real PayPal sandbox Orders v2 checkout, capture and refund against our sandbox merchant. Test money. No real furniture is sold or shipped. Retailer links are separate |

## How it works

| Step | Code |
| --- | --- |
| Room, owned furniture, slots, styles | `src/shared/room.ts` |
| Fit checks (shared by the Worker and the page) | `src/shared/fit.ts` |
| Product search and cache | `src/products/` |
| Model pick and the daily neuron cap | `src/ai/` |
| Design, swap, move | `src/design/` |
| Quote, PayPal order, capture, refund, webhooks | `src/checkout/`, `src/paypal/` |
| Page and 3D room | `src/client/` |

PayPal calls (sandbox only): `POST /v1/oauth2/token`, `POST /v2/checkout/orders` (intent CAPTURE, one item line per
room object), `POST /v2/checkout/orders/{id}/capture`, `GET /v2/checkout/orders/{id}`,
`POST /v2/payments/captures/{id}/refund`, `GET /v2/payments/refunds/{id}`, `POST /v1/notifications/verify-webhook-signature`.
Every write carries a `PayPal-Request-Id`. The quote and the design version are frozen together: a changed room cannot
be captured against an old quote.

## What it costs

Nothing. See `src/ai/ledger.ts` and `src/limits.ts` for the caps and the sums beside them.

## Run it yourself

```bash
npm ci
npm run gate
```

For a local server, copy `.dev.vars.example` to `.dev.vars`, fill in your own PayPal sandbox and Channel3 keys, then:

```bash
npx wrangler d1 migrations apply roomweft --local
npm run dev
```

Without keys the page still opens the recorded runs, the fit checks and the 3D room.

## Assets

See `docs/ASSETS.md`.

## Licence

MIT. See `LICENSE`.
