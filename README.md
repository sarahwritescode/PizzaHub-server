# PizzaHub Server

REST API for PizzaHub, a marketplace where vendors list pizza and other food, admins approve what goes public, customers
order it, and vendors can upgrade to a Premium plan through Stripe.

## Technology stack

| Area | Choice |
|---|---|
| Runtime / language | Node.js (ES modules), TypeScript 7 |
| Web framework | Express 5, `helmet`, `cors` |
| Database | MongoDB (Atlas), official `mongodb` driver. No ORM |
| Authentication | Better Auth (email + password, Google) with the JWT plugin |
| Validation | Zod 4 |
| Payments | Stripe Checkout (vendor Premium subscription only) and a signed webhook |
| Images | ImgBB (uploaded through the server, the key never reaches the browser) |
| Hosting | Vercel (`src/app.ts` is the entry point there, `src/server.ts` locally) |

The database has exactly four business collections: `users` (managed by Better Auth), `menuItems`, `orders`, `transactions`.
Better Auth keeps its own technical collections (`session`, `account`, `jwks`, ...) next to them.

## Setup

Requirements: a recent Node.js (developed and verified on Node 24), a MongoDB database (Atlas), and the keys listed below.

```bash
npm install
cp .env.example .env      # then fill in the values (see "Environment variables")
npm run dev               # http://localhost:5000
```

### Environment variables

`.env` is never committed (`.gitignore` ignores `.env` and `.env.*`, only `.env.example` is tracked). Variable names are in
[.env.example](.env.example); this table says what they do.

| Variable | Required | Purpose |
|---|---|---|
| `PORT`, `NODE_ENV` | no | Default `5000` and `development`. `production` makes the three Stripe variables mandatory |
| `CLIENT_URL` | yes | The frontend origin. The only browser origin allowed by CORS and Better Auth (plus `EXTRA_ALLOWED_ORIGINS`) |
| `EXTRA_ALLOWED_ORIGINS` | no | Extra exact `http(s)` origins, comma separated (no `*`). Not in `.env.example`; only for local frontends against a deployed API |
| `MONGODB_URI`, `DB_NAME` | yes | Database connection |
| `BETTER_AUTH_SECRET` | yes | At least 32 characters. Signs sessions and encrypts the JWT keys |
| `BETTER_AUTH_URL` | yes | Public URL of this API (JWT issuer and audience) |
| `JWT_EXPIRES_IN` | no | Lifetime of the API access token, default `15m` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes | Google sign-in |
| `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | only for `seed:admin` | The first admin account |
| `IMGBB_API_KEY` | for uploads | Without it the server starts and `POST /api/vendor/upload-image` answers 503 |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PREMIUM_PRICE_ID` | in production | Optional in development (payment endpoints answer 503); in production the server refuses to start without them. Use test-mode values until you go live |

### Database setup

Nothing to do by hand. On every start the server creates the collections, their validators and indexes if they are missing
(`src/config/initDatabase.ts`; safe to run repeatedly). `npm run verify:db` checks the result.
Create the first admin (sign-up can only create customers and vendors):

```bash
npm run seed:admin        # uses ADMIN_NAME / ADMIN_EMAIL / ADMIN_PASSWORD
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server with reload (`tsx watch src/server.ts`) |
| `npm run build` | Type-checks and compiles to `dist/` (`tsc`) |
| `npm start` | Runs the compiled server (`node dist/server.js`) |
| `npm run seed:admin` | Creates the admin user |

## Authentication overview

* Sign-up and sign-in are Better Auth endpoints under `/api/auth/*` (email + password, Google). Sign-up accepts only the
  roles `customer` and `vendor`; an admin can only be created by `seed:admin`.
* For the Express API the client gets a short-lived JWT from `GET /api/auth/token` and sends `Authorization: Bearer <JWT>`.
  The session cookie also works (cookie requests that change data must come from an allowed origin).
* Protected routes use `requireRole("customer" | "vendor" | "admin")`. It verifies the token or session, **loads the user
  from the database on every request** (role and `isBlocked` are never read from the token), refuses blocked accounts and then
  checks the role. 401 = not signed in or bad/expired token, 403 `FORBIDDEN` = wrong role, 403 `ACCOUNT_BLOCKED` = blocked.
* Details and manual checks: [docs/AUTH_TESTING.md](docs/AUTH_TESTING.md).

Every JSON response has `success` and `message`. Success adds `data` (and `pagination` on lists); errors add `code` and, for
validation, `errors: [{ field, message }]`.

## API modules

| Module | Base path | Who | Details |
|---|---|---|---|
| Health | `/api/health` | public | |
| Public menu | `/api/menu-items`, `/api/categories` | public | [docs/MENU_API_TESTING.md](docs/MENU_API_TESTING.md) |
| Vendor menu | `/api/vendor/menu-items` | vendor | [docs/VENDOR_MENU_TESTING.md](docs/VENDOR_MENU_TESTING.md) |
| Image upload | `/api/vendor/upload-image` | vendor | [docs/IMAGE_UPLOAD_TESTING.md](docs/IMAGE_UPLOAD_TESTING.md) |
| Admin menu moderation | `/api/admin/menu-items` | admin | [docs/ADMIN_MENU_TESTING.md](docs/ADMIN_MENU_TESTING.md) |
| Admin dashboard, users, vendors, transactions | `/api/admin/dashboard`, `/api/admin/users`, `/api/admin/vendors`, `/api/admin/transactions` | admin | [docs/ADMIN_API_TESTING.md](docs/ADMIN_API_TESTING.md) |
| Customer orders | `/api/orders` | customer | [docs/CUSTOMER_ORDERS_TESTING.md](docs/CUSTOMER_ORDERS_TESTING.md) |
| Vendor orders | `/api/vendor/orders` | vendor | [docs/VENDOR_ORDERS_TESTING.md](docs/VENDOR_ORDERS_TESTING.md) |
| Premium subscription | `/api/vendor/subscription` | vendor | [docs/STRIPE_SUBSCRIPTION_TESTING.md](docs/STRIPE_SUBSCRIPTION_TESTING.md) |
| Stripe webhook | `/api/stripe/webhook` | Stripe only (signature) | same document |
| Auth check endpoints | `/api/test/*` | any signed-in user / one role | [docs/AUTH_TESTING.md](docs/AUTH_TESTING.md) |

Business rules worth knowing: a menu item is public only while `approved` (and its vendor is not blocked); a Free vendor can
have at most 3 active items, a Premium vendor any number; one active order per customer, item and delivery day; only the
vendor who owns an item handles its orders; Premium is switched on only by a verified Stripe webhook, never by a redirect.
Pizza orders are not paid through Stripe.

Postman collections for most modules are in [docs/postman/](docs/postman/).

## Verification

Each script starts the real app on a random port, creates real users through Better Auth, calls the API over HTTP and uses a
**throwaway MongoDB database that is dropped at the end** (your data is never touched). They need the same `.env` as the
server. Stripe is tested against a local fake Stripe server, so no real Stripe call or charge is made; `verify:upload` needs internet for one real ImgBB call (invalid key).

```bash
npx tsc --noEmit                 # type check
npm run build                    # production build
npm run verify:db                # collections, validators, indexes
npm run verify:menu              # public menu
npm run verify:vendor            # vendor menu + Free/Premium limit
npm run verify:upload            # image upload (ImgBB is a local stand-in; one call uses the real ImgBB with a junk key)
npm run verify:origins           # CORS / trusted origins
npm run verify:admin-menu        # admin menu moderation
npm run verify:admin             # admin dashboard, users, block/unblock, transactions
npm run verify:customer-orders   # customer orders
npm run verify:vendor-orders     # vendor order handling
npm run verify:stripe            # Stripe checkout, signed webhook, Premium lifecycle
npm run verify:jwt-expiry        # an expired access token is refused
npm run verify:auth              # sign-up roles, update-user cannot change the role or protected fields
```

The full result of the last audit, including what has and has not been tested against real services, is in
[docs/FINAL_BACKEND_AUDIT.md](docs/FINAL_BACKEND_AUDIT.md).

## Deployment notes (Vercel)

* Set every variable above in the Vercel project settings (Production) and redeploy after changing any of them.
* A Vercel function refuses request bodies over **about 4.5 MB** before the app sees them (response `413
  FUNCTION_PAYLOAD_TOO_LARGE`, which is not this API's JSON format). Image uploads are limited to 5 MB per file and 5 files
  on paper, but on Vercel the whole request must stay under 4.5 MB: compress images in the browser or upload one per request.
* The Stripe webhook needs the raw request body; `src/app.ts` mounts it before the JSON parser. After deploying, send a test
  event from the Stripe Dashboard and check for a 200.
