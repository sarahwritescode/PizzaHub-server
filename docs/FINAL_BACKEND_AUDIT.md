# Final backend audit (Task 11)

Audit of the whole backend after Task 10. Everything under "Results" was actually run; anything that was not run is
listed under "Not tested" and is not claimed as working.

Audited commit: Task 10 `3476a1a` plus the Task 11 changes listed below. Date: 2026-11-23.

## 1. Results (all run, same session)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npm run build` | pass |
| `verify:db` | 41 passed, 0 failed |
| `verify:menu` | 97 passed, 0 failed |
| `verify:vendor` | 200 passed, 0 failed |
| `verify:upload` | 87 passed, 0 failed |
| `verify:origins` | 19 + 19 + 12 passed, 0 failed |
| `verify:admin-menu` | 155 passed, 0 failed |
| `verify:customer-orders` | 150 passed, 0 failed |
| `verify:vendor-orders` | 105 passed, 0 failed |
| `verify:stripe` | 139 passed, 0 failed |
| `verify:admin` (new in Task 10, extended here) | 171 passed, 0 failed |
| `verify:jwt-expiry` (new here) | 5 passed, 0 failed |

All of them run against a throwaway MongoDB Atlas database that is dropped at the end. Stripe and ImgBB are tested against
local stand-ins (see section 5 and 6).

## 2. Completed modules

Better Auth + JWT, role middleware, blocked-user protection, MongoDB models and indexes, public menu, vendor menu, ImgBB
upload, admin menu moderation, customer orders, vendor orders, Stripe Premium subscription, admin dashboard, admin user
management, admin transactions. Exactly four business collections: `users`, `menuItems`, `orders`, `transactions`.

## 3. Integration audit

| Check | Finding |
|---|---|
| Routes mounted in `app.ts` | Every router is mounted once, at its own path. The Stripe webhook is mounted with `express.raw()` **before** `express.json()`; Better Auth is mounted before both |
| Route conflicts | None. `/featured` is declared before `/:id` (public menu), `/my-orders` before `/:id` (orders). The three admin routers sit on separate paths, so an unknown `/api/admin/...` path is a plain 404, not a 401 |
| Middleware order | CORS, lazy DB connect, Better Auth, Stripe raw webhook, JSON parser, routes, 404, error handler. Every protected router starts with `requireRole(...)` |
| Endpoints without authentication | Only: `/api/health`, the public menu and categories, `/api/auth/*` (Better Auth), `/api/stripe/webhook` (protected by Stripe's signature instead) |
| Role restrictions | Each role is refused by the other roles' routers (403). An admin is refused by customer/vendor routes (checked in `verify:admin`, `verify:vendor`, `verify:customer-orders`, `verify:vendor-orders`) |
| Ownership | Vendors see and change only their own items and the orders of their own items; customers only their own orders. Someone else's resource looks like a missing one (404) |
| ObjectId validation | Every `:id` and ObjectId query value goes through a 24-hex Zod schema: 400 `VALIDATION_ERROR` |
| Pagination / filters | One helper (`buildPagination`), the same `page` / `limit` rules (limit 1 to 50, default 12) and `_id` as sort tie-breaker on every list |
| Error handling | One error handler: `{ success: false, message, code?, errors? }`. A 500 never shows the real message |
| Duplicate / dead code | No duplicate routes. See "Known issues" for two unused dependencies |

## 4. Security audit

**Authentication**: missing, invalid and expired JWTs are refused (401 `NO_CREDENTIALS` / `INVALID_TOKEN` / `TOKEN_EXPIRED`;
the expired case is tested by `verify:jwt-expiry` with a 2-second token). The signature, algorithm (pinned to EdDSA, so
`alg: none` and HS256 are refused), issuer, audience and expiry are verified. Blocked users get 403 `ACCOUNT_BLOCKED`, an
unknown role gets 403 `FORBIDDEN`.

**Authorization**: role and `isBlocked` are read from the database on every request, never from the token, so blocking takes
effect on the next request even for tokens issued before. Cookie requests that change data are refused from a foreign
`Origin` (CSRF guard, tested).

**Data**:
* Password hashes live in Better Auth's `account` collection; the admin APIs read `users` through an allow-list projection
  and the tests search every admin response for `password`, `token`, `secret`, `stripeCustomerId`, `sk_test`, `whsec_`.
* No mass assignment: every write schema is `strict`, so `role`, `status`, `vendorId`, `customerId`, `isBlocked`,
  `subscriptionPlan`, ... make the request a 400 instead of being ignored (tested for vendor menu, orders, subscription, admin).
  Sign-up cannot create an admin; Better Auth refuses `isBlocked` / `subscriptionPlan` from the client (`input: false`).
* Ownership is taken from the verified user or from the stored menu item, never from the request body.
* Logs: only error kinds are logged for Stripe, ImgBB and webhook failures (the ImgBB key is part of the fetch URL, so the
  error object is never logged there).

**Database**: unique email index (`users_email_uidx`), unique Stripe session id (`transactions_stripeSessionId_uidx`), unique
partial index for one active order per customer, item and day (`orders_active_customer_item_date_uidx`), collection
validators. Order status changes (customer cancel, vendor accept / reject), menu status changes, user block / unblock and
transaction updates are single conditional writes (`updateOne` with the expected current state), so parallel requests cannot
both win; races are tested (`verify:vendor-orders` 12 rounds, `verify:admin` 3 parallel blocks, `verify:stripe` parallel webhooks).

### Issues found in this audit and fixed

1. **A blocked vendor's items stayed on the public menu and could still be ordered.** After Task 10 added block / unblock,
   a blocked vendor could not accept or reject anything (every API refuses a blocked account), so new orders would sit
   `pending` forever. Fixed: the public list, detail, featured and categories hide the items of blocked vendors, and
   `POST /api/orders` answers 409 `MENU_ITEM_UNAVAILABLE` for them. Nothing is deleted; the items return when the vendor is
   unblocked, and orders placed before the block are untouched (the customer can still cancel them).
   Regression tests: `verify:admin` section 11.
2. While fixing it, the real Atlas connection (strict Stable API) refused `distinct()`; the first version of the fix failed
   in the test. The final code uses `find` + projection.
3. `.env.example` still had a dangling comment about `EXTRA_ALLOWED_ORIGINS` after that variable's line was removed; the
   comment was removed (the variable itself still works and is documented in the README).
4. `.vercel` was not in `.gitignore`; added.

No other security defect was found.

## 5. Stripe audit

Source: `src/services/subscription.service.ts`, `stripeWebhook.service.ts`, `controllers/stripeWebhook.controller.ts`, `app.ts`.

| Requirement | Verified by |
|---|---|
| Checkout needs an authenticated vendor | `verify:stripe` section 2 |
| The client cannot change the price, plan or vendor | section 3 (any body field is a 400; the price comes from `STRIPE_PREMIUM_PRICE_ID`) |
| Only verified webhook events activate Premium; a bad or missing signature is 400 and changes nothing | sections 5, 6, 13 |
| Duplicate / parallel deliveries create no duplicate transaction and do not extend Premium twice | section 7 |
| Renewal extends the paid period once | section 8 |
| Payment failure is recorded, Premium is kept until the paid period ends | section 10 |
| Cancellation / expiry returns the vendor to Free, nothing is deleted | section 11 |
| A redirect alone never activates Premium (the success URL is only a page; only the webhook writes) | sections 4, 6 |
| Pizza orders are never charged through Stripe | no Stripe code exists in the order modules |
| Admin transaction access is read-only | `verify:admin` section 8 (POST/PUT/PATCH/DELETE on transactions are 404, the collection is unchanged byte for byte); `verify:stripe` checks that no transaction write route exists |
| Production refuses to start without the three Stripe variables | section 1 |

**Test status, reported separately:**
* **Automated / mock: done.** 139 checks against a local fake Stripe API server with the real Stripe SDK pointed at it, and
  real `Stripe-Signature` headers built with the SDK's own test helper.
* **Real Stripe test mode: NOT done.** No real Checkout Session, card payment or Stripe-delivered webhook has been run.
* **Live payments: NOT done and not claimed.**

## 6. ImgBB audit

| Requirement | Result |
|---|---|
| Key read from the environment | `IMGBB_API_KEY` via `env.ts`; `.env` is not tracked |
| Key never reaches the frontend | Uploads go through the server; the response contains only the image URLs; the key is never put in a response or a log line (by code review; the fetch URL that contains it is never logged) |
| Invalid input rejected | Real file signature (JPEG / PNG / WEBP) is checked, not the extension or declared type; 5 files and 5 MB per file; 400 / 413 / 415 with codes |
| Upload failure handled safely | Timeouts, network errors, ImgBB 4xx / 429 / 5xx map to 502 / 503 / 504 `UPLOAD_*` codes; partial failures return the uploaded URLs |
| Only valid image URLs stored | Menu `images` accept only `http(s)` URLs (`javascript:` and `data:` are refused) |
| Existing upload tests | `verify:upload` 87 passed |

**Test status:** the successful-upload cases use a local stand-in for ImgBB. One check calls the **real** ImgBB with a junk
key and got its real "invalid key" answer. A **real successful upload with a valid key was NOT run** (it would publish an
image on ImgBB under your key).

**Vercel 4.5 MB limit: verified on the live deployment.** An anonymous 5,000,000-byte multipart POST to
`https://pizza-hub-server-jz3c.vercel.app/api/vendor/upload-image` was refused by Vercel itself with `413
FUNCTION_PAYLOAD_TOO_LARGE` (a plain-text page, not this API's JSON), before the app ran. So on Vercel the whole upload
request must stay under about 4.5 MB, even though the API allows 5 MB per file and 5 files. The frontend must compress images
or upload one per request. The API limits were left as they are (changing them would change a working contract).

## 7. CORS, environment and deployment audit

* CORS, Better Auth `trustedOrigins` and the cookie CSRF check use one list (`CLIENT_URL` plus `EXTRA_ALLOWED_ORIGINS`),
  exact origins only, never `*` (`verify:origins`: 50 checks).
* Required in every environment: `CLIENT_URL`, `MONGODB_URI`, `DB_NAME`, `BETTER_AUTH_SECRET` (at least 32 characters),
  `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Required in production: the three Stripe variables.
  Optional: `IMGBB_API_KEY` (uploads answer 503 without it), `JWT_EXPIRES_IN` (default 15m), `EXTRA_ALLOWED_ORIGINS`.
  A bad value stops the server at start-up with the variable named.
* Git: `.env` and `.env.local` are not tracked and were never in any commit (`git log --all -- .env .env.local` is empty);
  only `.env.example` is tracked and it has no values. A scan of tracked files, the Postman collections, the docs and the whole
  history for Stripe keys, webhook secrets, MongoDB URIs with passwords and Google secrets found nothing real (the only hit
  is the all-zero fake signature in the Postman collection).
* Variable names were not changed.
* `.gitignore` now also ignores `.vercel`. `docs/CLIENT_API_GUIDE.md` stays gitignored on purpose (local notes for the
  frontend developer; it was updated).

**Deployment status (checked on 2026-11-23, nothing was deployed by this task):**

| Request to `https://pizza-hub-server-jz3c.vercel.app` | Answer |
|---|---|
| `GET /api/health` | 200, database connected |
| `POST /api/stripe/webhook` | **404** `Route not found` |
| `GET /api/admin/dashboard` | **404** `Route not found` |

The live deployment is therefore an older build: it does **not** contain the Stripe webhook (Task 09) or the admin APIs
(Task 10). Push and redeploy, set the three Stripe variables first, then run the webhook check from the Stripe Dashboard.
The raw-body webhook has therefore **not** been verified on Vercel yet.

## 8. Documentation

README.md (new), docs/CLIENT_API_GUIDE.md (admin dashboard, users, transactions, blocked-vendor behaviour; local only),
docs/ADMIN_API_TESTING.md (new), this file, `.env.example` (cleaned). A Postman collection for the new admin endpoints was
not created (not requested); `docs/ADMIN_API_TESTING.md` lists the requests.

## 9. Known issues and limitations

1. **Nothing of Tasks 09 and 10 is deployed yet** (section 7).
2. **No real Stripe test-mode run and no real ImgBB upload yet** (sections 5, 6).
3. **No application-level rate limiting.** `express-rate-limit` is in `package.json` but is not used anywhere. Better Auth has
   its own limiter for its endpoints (not verified here). On Vercel an in-memory limiter is per instance, so a real limit
   would need shared storage. Not added: it is not part of the existing contract and would need a decision.
4. Unused dependencies: `express-rate-limit` and `cookie-parser` (also `@types/cookie-parser`). Harmless; remove them if you
   do not plan to use them.
5. `/api/test/*` (the auth demo endpoints) are also live in production. They need a login and return only the caller's own
   id, email and role, so they leak nothing, but they are not product features.
6. Pending orders of a vendor who gets blocked stay `pending` until the vendor is unblocked (the customer can cancel). There is
   no admin endpoint to settle orders.
7. Admins can never be blocked through the API (policy in `docs/ADMIN_API_TESTING.md`). If one must be locked out, it is a
   database change.
8. No endpoint to change a user's role or delete a user; no Stripe customer portal or vendor-side transaction history.
9. `node_modules` was committed in the first two commits and removed in `3c116aa`; it is still in the Git history (size only,
   no secrets found).
10. Orders store no price snapshot: an order shows the item's current price.

## 10. Frontend integration readiness

* **Ready to build against locally.** No contract mismatch was found between the code, the tests and
  `docs/CLIENT_API_GUIDE.md`; every response follows `{ success, message, data?, pagination? }` / `{ success: false, message, code?, errors? }`.
* **Blockers before the frontend can use production:** (a) deploy the latest commit, (b) set the three Stripe variables on Vercel
  first (the server refuses to start in production without them), (c) create the Stripe webhook endpoint and check it returns
  200, (d) keep each upload request under 4.5 MB.
* Frontend pages still to be built (server side is ready): `/dashboard/vendor/subscription` (poll the status after
  `?checkout=success`), the admin dashboard, users and transactions screens.
