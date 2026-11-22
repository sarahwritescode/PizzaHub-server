# Vendor Premium subscription with Stripe (Task 09)

Two things happen here, and they are kept apart on purpose:

1. **Checkout** (`POST /api/vendor/subscription/checkout`): the vendor gets a Stripe Checkout URL and pays on Stripe's page.
2. **Webhook** (`POST /api/stripe/webhook`): Stripe tells the server what happened. **Only a verified webhook activates
   Premium.** Landing on the success URL does nothing by itself.

## What the project did not define (so it is configuration, not code)

The project and the assignment give no price, currency, billing period or Stripe Price id. Nothing is invented: you create the
Premium **Price** in Stripe and put its id in `STRIPE_PREMIUM_PRICE_ID`. The amount, currency and billing period are whatever
that Price says. The API never sends an amount to Stripe and a client can never send one (a body with any field is a 400).

## Environment variables

| Variable | Value | Required |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` (or `sk_live_...`, or a restricted `rk_...`) | production: yes |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` signing secret of the webhook endpoint | production: yes |
| `STRIPE_PREMIUM_PRICE_ID` | `price_...` of the recurring Premium Price | production: yes |
| `CLIENT_URL` | the frontend (already required); the success and cancel pages are on it | yes |

- When `NODE_ENV=production` the server **refuses to start** if any of the three is missing, and says which. A value that is set
  but has the wrong shape (`secret123`, a `prod_...` id instead of `price_...`) is refused in every environment.
- In development they are optional: without them everything else works, checkout answers `503 STRIPE_NOT_CONFIGURED`, and the
  webhook answers `503`.
- Nothing is hard-coded. Keys are never logged or returned.

## Where the customer goes

| | URL |
|---|---|
| success | `{CLIENT_URL}/dashboard/vendor/subscription?checkout=success` |
| cancel | `{CLIENT_URL}/dashboard/vendor/subscription?checkout=cancelled` |

These are frontend routes (one page, a query parameter). The success page must **not** assume Premium: show "processing" and
poll `GET /api/vendor/subscription` until `isPremium` is true (usually a second or two).

## A. Start a checkout

`POST /api/vendor/subscription/checkout`, `Authorization: Bearer <vendor JWT>`, body `{}` (or none).

```json
// 201 (200 when the vendor already has an open checkout: the same session is returned)
{ "success": true, "message": "Checkout session created. Redirect the vendor to the url to pay.",
  "data": { "url": "https://checkout.stripe.com/c/pay/cs_test_...", "sessionId": "cs_test_..." } }
```

What the server does: loads the vendor from the database, refuses if they are already Premium, reuses their Stripe customer (or
creates one once and stores it), creates a Checkout Session in `subscription` mode with the server's Price, the vendor's id in
`client_reference_id`, `metadata` and `subscription_data.metadata`, and records a **pending** transaction.

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | any body field (`priceId`, `amount`, `currency`, `plan`, `vendorId`, URLs...) |
| 401 / 403 | `NO_CREDENTIALS`, `INVALID_TOKEN`, `TOKEN_EXPIRED` / `FORBIDDEN`, `ACCOUNT_BLOCKED` | not an allowed vendor |
| 409 | `ALREADY_PREMIUM` | the vendor's Premium is active |
| 409 | `SUBSCRIPTION_EXISTS` | the paid date has passed but Stripe still has a live subscription (`active`, `past_due`, `trialing`): a second checkout would bill twice |
| 502 | `PAYMENT_SERVICE_ERROR` | Stripe could not be reached |
| 503 | `STRIPE_NOT_CONFIGURED` | the Stripe variables are not set |

A double click (or four requests at once) gives back **one** session: an open session is reused, and Stripe idempotency keys cover
the requests that arrive at the same moment. A vendor who cancelled, or whose checkout expired, gets a new session.

## B. My subscription

`GET /api/vendor/subscription`, vendor only. Reads the database only (works even if Stripe is not configured).

```json
// 200
{ "success": true, "message": "Subscription fetched successfully",
  "data": { "subscriptionPlan": "premium", "isPremium": true, "subscriptionStatus": "active",
            "subscriptionExpiresAt": "2026-12-22T10:00:00.000Z", "cancelAtPeriodEnd": false,
            "stripeSubscriptionId": "sub_..." } }
```

- `subscriptionPlan` is the **effective** plan: `premium` only while `subscriptionExpiresAt` is in the future (the same rule the
  menu API uses), so it never says premium for an expired plan.
- `subscriptionStatus` is Stripe's status (`active`, `past_due`, `unpaid`, `canceled`, ...) or `none` for a vendor who never paid.
- `cancelAtPeriodEnd: true` means "cancelled, still Premium until `subscriptionExpiresAt`".
- Not returned: Stripe keys, the webhook secret, the Stripe customer id, card or payment details.

## C. The webhook

`POST /api/stripe/webhook`, public. Mounted with `express.raw()` **before** `express.json()`: Stripe signs the exact bytes it sent,
so a parsed body could never be verified. Every other route still gets the normal JSON parser.

| Answer | When |
|---|---|
| 200 `{ success: true, data: { received: true } }` | verified; handled or deliberately ignored |
| 400 `INVALID_SIGNATURE` | header missing, malformed, wrong secret, body changed, or older than 5 minutes (replay) |
| 400 `INVALID_PAYLOAD` | the body reached the handler already parsed (misconfigured proxy / middleware) |
| 500 `WEBHOOK_HANDLING_FAILED` | something failed while handling (Stripe API or database): Stripe retries |
| 503 `STRIPE_NOT_CONFIGURED` | no `STRIPE_WEBHOOK_SECRET` |

### What each event does

| Event | Meaning | Effect |
|---|---|---|
| `checkout.session.completed` | the first payment (paid) | transaction `pending` to `success`; **Premium on** until the end of the paid period; Stripe customer and subscription ids stored. If `payment_status` is not `paid` (a delayed payment method) nothing is activated; `invoice.paid` does it later |
| `invoice.paid` | a payment succeeded (first or renewal) | the paid-until date moves to the end of that invoice's period (it only moves forward). No new transaction |
| `invoice.payment_failed` | a payment failed | status recorded (`past_due`). **Premium is NOT switched off**: the vendor keeps what is already paid for. If it was the first payment the checkout's transaction becomes `failed` (it turns `success` if the customer retries and pays) |
| `customer.subscription.updated` | the subscription changed | follows Stripe: `cancel_at_period_end`, status. Only `active` extends access; `past_due` does not (its new period is not paid); `canceled`, `unpaid`, `incomplete_expired` end it |
| `customer.subscription.deleted` | the subscription ended | plan back to **Free**, paid access ends now. Pending transactions of it become `cancelled` / `expired` |
| `checkout.session.expired` | the customer never paid | the pending transaction becomes `expired` (extra to the five asked for; without it an abandoned checkout would stay `pending` forever) |

Anything else is acknowledged with 200 and ignored.

### Why a repeated or out-of-order event is harmless

- Every write sets an absolute state; the paid-until date only moves forward. Nothing counts or appends.
- A transaction is one row per Checkout Session (unique index on `stripeSessionId`), created with an upsert.
- The subscription is re-read from Stripe on each event, so a stale snapshot cannot undo newer state.
- An old subscription ending cannot downgrade a vendor's current one (the write is keyed by subscription id).
- The writes of one event run in one MongoDB transaction: Premium and its transaction row change together or not at all. On a
  failure the answer is 500 and Stripe retries.

### Data that is not trusted (acknowledged, nothing activated)

A subscription without our `vendorId` and `plan: premium` metadata, a vendor that does not exist, a different Stripe customer
than the vendor's, a `client_reference_id` or session metadata naming someone else, a paid session without a positive amount,
a currency, or a paid period, and a session that is not in subscription mode.

### A second subscription for the same vendor

Prevented at checkout (409). If two checkouts were open and both get paid, the second subscription is **not** linked, its
transaction is recorded as `cancelled`, and the server cancels it at Stripe so it is not billed again. **The first charge of
that second subscription has to be refunded by hand in the Stripe Dashboard**; an error line says so in the server log.

## Transactions

The existing `transactions` collection is used; there is no new collection. One row per Checkout Session:

| Field | |
|---|---|
| `vendorId`, `plan` (`premium`), `createdAt` | set when the checkout is created |
| `amount` | in the normal unit (`19.99`, not 1999 cents; zero-decimal currencies like JPY are whole numbers). Taken from Stripe's session, never from the client |
| `currency` | lower-case ISO code (`usd`) |
| `stripeSessionId` | unique |
| `stripeSubscriptionId` | `null` until the subscription is known |
| `status` | `pending`, `success`, `failed`, `cancelled`, `expired` |

Status moves: `pending` to `success` / `failed` / `cancelled` / `expired`, and `failed` to `success` (a retry that works). A
`success` row is never rewritten. **Renewals do not create transactions**: the schema is one row per Checkout Session
(`stripeSessionId` is required and unique), so a renewal only extends the paid period.

There is no API to create, edit or delete transactions, for admins or anyone else. A checkout whose session has no positive
amount cannot be stored (the collection refuses it); it is then recorded by the webhook only if it is a real paid one.

## Stored on the user

`subscriptionPlan`, `subscriptionExpiresAt` (already existed) plus four optional fields written only by the checkout code and
the verified webhook: `stripeCustomerId`, `stripeSubscriptionId`, `subscriptionStatus`, `subscriptionCancelAtPeriodEnd`. They
are additive on the `users` collection (which has no validator), and Better Auth never returns them.

When Premium ends, the vendor's menu items are **not** touched: nothing is deleted or deactivated, and the Free-plan rules apply
from then on (a vendor over the limit cannot create or re-activate items until they are back under it).

## Stripe Dashboard configuration

1. **Product and Price:** Product catalogue, add a product (for example "PizzaHub Premium") with a **recurring** Price. Copy the
   Price id (`price_...`) to `STRIPE_PREMIUM_PRICE_ID`. Use test mode first.
2. **API key:** Developers, API keys, copy the secret key to `STRIPE_SECRET_KEY`.
3. **Webhook endpoint:** Developers, Webhooks, add endpoint `https://<your-api-domain>/api/stripe/webhook`, and select these events:
   `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.updated`, `customer.subscription.deleted`. Copy its signing secret (`whsec_...`) to `STRIPE_WEBHOOK_SECRET`.
4. **Customer portal (optional):** there is no portal endpoint in this API; a customer can only cancel through Stripe, so enable
   the portal or cancel from the Dashboard when testing cancellation.
5. Test mode and live mode have separate keys, Prices and webhook secrets. Switching to live means changing all three variables.

## Vercel environment variables

Project Settings, Environment Variables (Production, and Preview if you use it): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PREMIUM_PRICE_ID`. **Add them before deploying**: with `NODE_ENV=production` the server refuses to start without them.
Redeploy after changing them.

## Automated check (safe, no Stripe account)

```bash
npm run verify:stripe
```

**What is real:** the Express app, Better Auth sign-up and JWTs, MongoDB (including multi-document transactions), the real Stripe
SDK, and the real signature check: the requests are signed with the SDK's own signer using a *test* signing secret.
**What is not real:** Stripe itself. The SDK is pointed at a small stand-in for the Stripe API inside the script, and the events
are written by hand in the shape of the installed SDK's current objects (API version `2026-11-18.endive`). It proves how this
server behaves. It does **not** prove that your Stripe account, Price or webhook endpoint are set up correctly, and it is not a
live payment test. It runs in a throwaway database that is dropped at the end.

## Real Stripe test mode (manual, needs your keys)

1. Put the test-mode `sk_test_...` and `price_...` in `.env`. Run the API on a demo database.
2. Install the [Stripe CLI](https://docs.stripe.com/stripe-cli), `stripe login`, then
   `stripe listen --forward-to localhost:5000/api/stripe/webhook`. It prints a `whsec_...`: put it in `STRIPE_WEBHOOK_SECRET`
   and restart the API.
3. Run the Postman folders 1 to 6 (no Stripe needed), then folder 7: it creates a checkout; open `checkoutUrl` and pay with card
   `4242 4242 4242 4242`, any future date, any CVC. Then run the status request: Premium appears once the webhook has been processed.
4. Other cases: card `4000 0000 0000 0341` (attaches, then the payment fails), cancel the subscription in the Dashboard
   (`customer.subscription.deleted`), `stripe trigger invoice.payment_failed`. Check the transaction rows in Compass.

## Postman

Import [postman/PizzaHub-StripeSubscription.postman_collection.json](postman/PizzaHub-StripeSubscription.postman_collection.json).
Demo database only (`$env:DB_NAME = "pizzahub_stripe_demo"; npm run dev`, then `npm run seed:admin` for the admin, whose email and
password go into `adminEmail` / `adminPassword`). Clear the `localhost` cookies, run the folders in order.

Folders 1 to 6 (access, "the client cannot choose the price", webhook signature rejection, the Free status) need no Stripe. Folder
7 is the real Stripe test-mode flow above. The webhook cannot be signed from Postman without the secret, so the valid-signature
cases are covered by `npm run verify:stripe` and by Stripe CLI.

| # | Case | Where |
|---|---|---|
| 1 | Vendor creates a checkout | `verify:stripe` (stand-in), Postman folder 7 (real test mode) |
| 2 | Customer cannot | folder 3, `verify:stripe` |
| 3 | Admin cannot | folder 3, `verify:stripe` |
| 4 | Not signed in | folder 1, `verify:stripe` |
| 5 | Blocked vendor | `verify:stripe` |
| 6 | Client cannot choose the price | folder 4, `verify:stripe` |
| 7 | Missing / invalid signature | folder 5, `verify:stripe` |
| 8 | Valid signature | `verify:stripe`, Stripe CLI |
| 9 | Success redirect alone does not activate | `verify:stripe`, folder 7 |
| 10 | Verified webhook activates | `verify:stripe`, folder 7 |
| 11 | Duplicate events | `verify:stripe` |
| 12 | Subscription updated | `verify:stripe` |
| 13 | Deleted / expired: Free again | `verify:stripe` |
| 14 | Payment failure | `verify:stripe`, `stripe trigger` |
| 15 | Transaction statuses | `verify:stripe` |
| 16 | Vendor sees their subscription | folder 6, folder 7, `verify:stripe` |
| 17 | Other roles refused | folder 3, `verify:stripe` |
| 18 | No secret in the responses | folder 6, `verify:stripe` |

The collection's folders 1 to 6 were run with a small stand-in for Postman's `pm` object against the real app (38 checks passed).
Folder 7 was **not** run: it needs real Stripe test-mode credentials.
