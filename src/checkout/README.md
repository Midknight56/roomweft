# Checkout integration

Status: 6 November 2026. The sandbox client, checkout service, webhook handler and migration are implemented.
The local gate passed 130 tests, including 89 new payment and checkout tests.

Apply `migrations/0002_checkout.sql` before wiring the routes. No packages were added.

Construct `PayPalClient` with the Worker secret bindings passed as `clientId` and `secret`.
Construct `CheckoutService` with `db`, `paypal`, `designs`, `returnUrl` and `cancelUrl`.
`designs.get(designId, visitor)` must check design ownership and return a current snapshot or null.
The full shared `DesignView` satisfies `DesignSnapshot`. Prices use `priceCents`.

Public service methods are `freezeQuote`, `startCheckout`, `completeReturn`, `cancelReturn`,
`refundLine` and `receipt`. Each checks ownership. Their result is either `{ ok: true, value }`
or `{ ok: false, code, error, quote? }`. The quote and receipt values use the shared API shapes.
`startCheckout` can also return success with `code: "already_started"`; its quote includes the
saved `approveUrl` when known. Map `not_found` to HTTP 404. A `checking_payment` result must show
the payment status and must not cause a new order.

`startCheckout` accepts an optional server price hook, `recheck(lines)`. It returns an array
of `{ lineId, priceCents }` for checked items. Use null for a gone item. An unchanged item may
be omitted. Every change, including a lower price, requires a new quote. Never read a client total.
Return and cancel URLs come from trusted server configuration, not request body fields.

Construct `CheckoutWebhook` with `db`, `paypal`, `checkout` and the Worker webhook secret as
`webhookId`. Pass the original headers and `await request.text()` to `handleWebhook` exactly once.
Do not parse and serialize the request body first. Return the handler's `Response`.
`reconcile`, `refreshRefund` and `processPendingEvents` are internal recovery methods, not public
routes. Receipt loads replay retained events for the owned quote and refresh uncertain refunds.

The migration includes `approve_url` and `repriced` so recovery does not depend on one service
instance. `refunds.line_id` is a JSON pair `[quoteId, lineId]` to keep its required UNIQUE constraint
without colliding with the same slot in a different basket. The public line id remains the slot.
Refund reservations include pending and unknown refunds. A confirmed failure releases its cents once.

Render `amountMismatch` and `quote.error` visibly. A completed refund sets that room object's plan
status to `returned`. Keep the room object and show: "Returned. Your plan differs until you approve
a new quote." The service does not change designs.

The route owner still wires visitor cookies, daily checkout and refund caps, environment bindings,
and the status page. No Worker routes or shared types were changed here. No live sandbox request,
webhook registration or deployment was attempted because network access is blocked.

Validation: `npm.cmd run gate` from this worktree. Tests use scripted fetch, fake clock and ids,
and the existing `freshD1` helper backed by Node SQLite. No helper processes were started.
