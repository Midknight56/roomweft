# RoomWeft

Keep the furniture you own. RoomWeft fits the missing pieces around it, checks the door swing, the walkway and your
budget, lets you walk through the room in 3D, and then you pay for the basket in one PayPal sandbox checkout.

Live: https://roomweft.midknight-labs.workers.dev

## For judges

No login is needed. Pay with PayPal's published sandbox test card. The PayPal button uses a sandbox buyer (test money
only), whose email and password are in the "For judges" box at the bottom of the page.

The 60 second path:

1. Open the page. Calm studio loads from a saved live run. The reading chair shows red: it blocks the door swing.
2. Press "Swap for one that fits". Press Plan to see the walkway path from the door, then Walk and move through the
   room with W, A, S and D (on a phone, drag).
3. Freeze the quote and press "Pay with the test card". Every receipt line is tied to an object in the room, and the
   receipt lists the PayPal webhook events that passed the signature check. Refund one item and watch the plan and the
   receipt part ways.
4. Optional: type a sentence about the room and press "Search live" for a new design from live product search.

What is real and what is not:

| Part | Real or simulated |
| --- | --- |
| Product search | Real Channel3 API calls. The page opens on one saved live run per style from 6 Nov 2026, labelled "Saved live run". "Search live" makes a new one (three a day per visitor). When a daily cap is spent, the page says so and uses the saved run |
| Sizes | From the retailer listing through Channel3. A missing size is shown as "fit unverified", never guessed |
| 3D furniture | Our own furniture models, scaled to the listed size when the listing gives a usable size, and coloured from the listing. Not the exact product |
| Fit checks | Done in code: walls, overlaps, door swing, a 76 cm walkway, budget |
| Room brief | Workers AI Granite 4.0 H Micro reads the renter's sentence into a style, a budget and search words from a fixed list. Code checks every field. A saved run shows the words it really searched with, labelled as saved |
| Model picks | The same model picks a candidate per slot for taste and writes a short reason. Code checks every pick. Saved runs keep their recorded picks |
| Payment | Real PayPal sandbox Orders v2 checkout against our sandbox merchant: the published sandbox test card (Visa 4012888888881881) with no login, or the PayPal button with a sandbox buyer. Real capture and refund. Test money. No real furniture is sold or shipped. Retailer links are separate |

## How it works

Live picks use `@cf/ibm-granite/granite-4.0-h-micro`, with one required JSON key per slot. Invalid picks fall back to
rules and are labelled. Calls hold 10 neurons, then settle reported neurons or token usage at the model's rates.
Run `npm run check:model` online to check the configured model page for deprecation. The gate stays offline.

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
room object; `payment_source.card` for the test card, `payment_source.paypal` for the button), `POST /v2/checkout/orders/{id}/capture`, `GET /v2/checkout/orders/{id}`,
`POST /v2/payments/captures/{id}/refund`, `GET /v2/payments/refunds/{id}`, `POST /v1/notifications/verify-webhook-signature`.
Every payment and refund write carries a stable `PayPal-Request-Id`. The quote and the design version are frozen together: a changed room cannot
be captured against an old quote. A price older than six hours is checked again with the shop before payment; if that check
fails, no payment starts. A changed shop price is saved to the room so the next quote can pay.

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
