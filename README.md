# RoomWeft

Keep the furniture you own. RoomWeft fits the missing pieces around it, checks the door swing, the walkway and your
budget, lets you walk through the room in 3D, and then you pay for the basket in one PayPal sandbox checkout.

Live: https://roomweft.midknight-labs.workers.dev

## Judging criteria at a glance

**In short.** RoomWeft is for renters who keep the furniture they own and need a few more pieces. Enter the room and the pieces that stay, then say what you want in one sentence. AI turns the sentence into a budget and search words. Channel3 returns real products, and code checks every piece against the walls, the door swing and a 76 cm walkway. Freeze the quote and pay by card through PayPal. A refund is tied to its piece in the room.

**Technological Implementation.** PayPal Orders v2 (create and capture, a card payment source for the test card, an order read to recover a lost answer), Payments v2 (refund of one line, refund read) and webhooks checked with PayPal's signature verification. AI: IBM Granite 4.0 H Micro on Workers AI turns one sentence into a search brief and picks one candidate per slot; code checks every field. On 9 Nov the build passed 536 unit tests and 28 named browser checks. Channel3 product search supplies the real products and their listed sizes. Check it: [src/checkout/service.ts](https://github.com/Midknight56/roomweft/blob/main/src/checkout/service.ts), [src/checkout/webhook.ts](https://github.com/Midknight56/roomweft/blob/main/src/checkout/webhook.ts), [src/products/channel3.ts](https://github.com/Midknight56/roomweft/blob/main/src/products/channel3.ts), [src/ai/pick.ts](https://github.com/Midknight56/roomweft/blob/main/src/ai/pick.ts).

**Design.** A 3D room with overview, plan and walk views. Every pick is checked against your walls, the door swing and a 76 cm walkway, which is drawn on the floor. A piece without a usable size says "fit unverified". Check it: [src/client/door.ts](https://github.com/Midknight56/roomweft/blob/main/src/client/door.ts), [src/client/walkway-strip.ts](https://github.com/Midknight56/roomweft/blob/main/src/client/walkway-strip.ts).

**Potential Impact.** For renters who keep the furniture they own and need a few more pieces. A chair that looks right in a photo can still block the door when it arrives.

**Innovation/Idea.** Real products fitted around the furniture you already own, with the same geometry checks on the server and the page. A refund is tied to the object in the room, and its replacement gets a new one piece quote. A product photo shows a piece alone. RoomWeft checks it against your walls and the furniture you keep before you pay. Check it: [src/design/rules.ts](https://github.com/Midknight56/roomweft/blob/main/src/design/rules.ts).

**Presentation.** The video runs 2 minutes 58 seconds. At https://roomweft.midknight-labs.workers.dev a judge can pay with the sandbox test card in about a minute, with no login. Video guide: 0:27 a chair that blocks the door; 0:39 one click swaps in a chair that fits; 0:53 the 76 cm walkway check fails; 1:08 a rug with no size is marked fit unverified; 1:53 pay by card through PayPal; 2:13 refund one piece and the room shows it.

## For judges

No login is needed. Pay with PayPal's published sandbox test card. The PayPal button uses a sandbox buyer (test money
only), whose email and password are in the "For judges" box at the bottom of the page.

The 60 second path:

1. Open the page. Calm studio loads from a saved live run. The reading chair shows red: it blocks the door swing.
2. Press "Swap for one that fits". Press Plan to see the walkway path from the door, then Walk and move through the
   room with W, A, S and D (on a phone, drag).
3. Freeze the quote and press "Pay by card". Every receipt line is tied to an object in the room, and the
   receipt lists the PayPal webhook events that passed the signature check. Refund one item and watch the plan and the
   receipt part ways. Then press "Replace this item": the new quote holds only the replacement, and the first receipt
   stays as it was.
4. Optional: type a sentence about the room and press "Search live" for a new design from live product search.
5. Optional: under "Room size", enter your own room, door and furniture sizes and press Apply.

What is real and what is not:

| Part | Real or simulated |
| --- | --- |
| Product search | Real Channel3 API calls. The page opens on one saved live run per style from 6 Nov 2026, labelled "Saved live run". "Search live" makes a new one (three a day per visitor). When a daily cap is spent, the page says so and uses the saved run |
| Sizes | From the retailer listing through Channel3. A missing size is shown as "fit unverified", never guessed |
| 3D furniture | Our own furniture models, scaled to the listed size when the listing gives a usable size, and coloured from the listing. Not the exact product |
| Room | A 380 by 320 cm sample room opens first. You can enter your own width, depth, door place and width, and the sizes of your desk, desk chair and bookshelf. Rectangular rooms with one door on the south wall only |
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
| Design, swap, move, room size | `src/design/` |
| Quote, PayPal order, capture, refund, replacement, webhooks | `src/checkout/`, `src/paypal/` |
| Page and 3D room | `src/client/` |

PayPal calls (sandbox only): `POST /v1/oauth2/token`, `POST /v2/checkout/orders` (intent CAPTURE, one item line per
room object; `payment_source.card` for the test card, `payment_source.paypal` for the button), `POST /v2/checkout/orders/{id}/capture`, `GET /v2/checkout/orders/{id}`,
`POST /v2/payments/captures/{id}/refund`, `GET /v2/payments/refunds/{id}`, `POST /v1/notifications/verify-webhook-signature`.
Every payment and refund write carries a stable `PayPal-Request-Id`. The quote and the design version are frozen together: a changed room cannot
be paid against an old quote. While a payment is being ordered or captured, the server refuses any change to the room, and it
checks the room version again right before it orders and right before it captures. A price older than six hours is looked up again through Channel3 before payment
(that lookup may use a saved answer up to six hours old); if that check
fails, no payment starts. A changed shop price is saved to the room so the next quote can pay. A refunded piece can be
replaced with a new quote that holds only that piece, linked to the first receipt. A repeated request returns the same
replacement quote, and the old refund marks only the old product as returned. Changing the room size raises the design
version, so a quote for the old room cannot be paid.

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
