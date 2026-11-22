# Authentication testing

The API accepts two kinds of credentials. Both are verified by Better Auth; the server never trusts a user id, role or `isBlocked` sent by the client.

| Credential | Header | Used by |
|---|---|---|
| **Access JWT** (signed by Better Auth) | `Authorization: Bearer <jwt>` | Postman, mobile apps, other services |
| Session cookie | `Cookie` (set at sign-in) | The browser frontend |

If an `Authorization` header is present it is the only credential considered: a bad token is a 401, it never falls back to the cookie.

## How the JWT check works

1. `GET /api/auth/token` (needs a signed-in session) returns a short-lived JWT, signed with an EdDSA key stored in the `jwks` collection. Lifetime: `JWT_EXPIRES_IN` (default `15m`).
2. `GET /api/auth/jwks` publishes the public keys.
3. For every protected request `requireAuth` (`src/middleware/auth.ts` + `src/lib/jwt.ts`) verifies the **signature**, the algorithm (`EdDSA` only), `exp`, `iss`, `aud` and the presence of `sub`.
4. The user is then loaded from the database using the verified `sub`. `role` and `isBlocked` come from the database on every request, not from the token, so blocking or changing a user takes effect immediately even for tokens already issued.

## Get a token (Postman)

1. `POST {{baseUrl}}/api/auth/sign-in/email`, header `Origin: http://localhost:3000`, body
   `{ "email": "...", "password": "..." }`. Postman stores the session cookie.
2. `GET {{baseUrl}}/api/auth/token` returns `{ "token": "eyJ..." }`.
3. On the request you want to test: **Authorization** tab, type **Bearer Token**, paste the token (or header `Authorization: Bearer <token>`).

Users: customer and vendor sign up with `POST /api/auth/sign-up/email` (`role` is `customer` or `vendor`). Admin accounts exist only through `npm run seed:admin` (set `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` in `.env`).

## Endpoints

| Endpoint | Needs |
|---|---|
| `GET /api/health` | nothing |
| `/api/auth/*` (sign-in, sign-up, token, jwks, ...) | nothing (Better Auth handles it) |
| `GET /api/test/protected` | any signed-in, non-blocked user |
| `GET /api/test/customer` | role `customer` |
| `GET /api/test/vendor` | role `vendor` |
| `GET /api/test/admin` | role `admin` |

Success body (only these three fields are ever returned):

```json
{ "success": true, "user": { "id": "...", "email": "...", "role": "customer" } }
```

## When you get 401 and 403

Every failure is `{ "success": false, "code": "...", "message": "..." }`.

| Status | `code` | Meaning |
|---|---|---|
| 401 | `NO_CREDENTIALS` | No `Authorization` header and no valid session cookie |
| 401 | `INVALID_TOKEN` | Malformed header, bad signature, wrong algorithm / issuer / audience, no `sub`, or the user no longer exists |
| 401 | `TOKEN_EXPIRED` | Valid signature but `exp` has passed: request a new token |
| 403 | `ACCOUNT_BLOCKED` | Credentials are fine but the user is blocked |
| 403 | `FORBIDDEN` | Signed in, but the role is not allowed on this endpoint |
| 403 | `ORIGIN_NOT_ALLOWED` | Cookie-authenticated request that changes data, sent from another site (CSRF guard) |

## Test cases

Import `docs/postman/PizzaHub-Auth.postman_collection.json` and run the folders in order; each request has Postman tests with the expected result.
Edit the `adminEmail` / `adminPassword` collection variables to the admin you seeded.

| # | Test | Request | Expected |
|---|---|---|---|
| 1 | No credentials | `GET /api/test/protected`, no header, **empty cookie jar** | 401 `NO_CREDENTIALS` |
| 2 | Invalid credential | `Authorization: Bearer not.a.valid.jwt` | 401 `INVALID_TOKEN` |
| 3 | Valid credential | `Bearer <customer jwt>` on `/protected` | 200, `user` has `id`, `email`, `role` |
| 4 | Expired credential | Use an old token after its lifetime. Quick way: `JWT_EXPIRES_IN=10s`, restart, get a token, wait 15 s | 401 `TOKEN_EXPIRED` |
| 5 | Customer | `/customer` 200, `/vendor` 403, `/admin` 403 | as listed, 403 is `FORBIDDEN` |
| 6 | Vendor | `/vendor` 200, `/customer` 403, `/admin` 403 | as listed |
| 7 | Admin | `/admin` 200, `/vendor` 403, `/customer` 403 | as listed |
| 8 | Blocked user | Get a token, then set `isBlocked: true` on that user in the `users` collection, call `/protected` again; also try to sign in again | 403 `ACCOUNT_BLOCKED` for both |

Postman automatically sends the session cookie after you sign in. That is fine for cases 2 to 8 (the Bearer token wins), but for case 1 delete the cookies first (**Cookies** link under Send, then delete the `localhost` cookies).

## Security notes

- **Why not trust the token's role:** a JWT is valid for minutes, a user can be blocked or demoted in that time. Only the identity (`sub`) is taken from the verified token; role and `isBlocked` are read fresh.
- **Why the algorithm is pinned:** accepting whatever `alg` the token claims allows `none` / HS256 forgery. Only `EdDSA` is accepted.
- **Why the Origin rule:** with `sameSite: "none"` cookies (production, different domains) a malicious site could make the browser send the cookie. Cookie-authenticated requests that change data are refused when `Origin` is another site. Bearer requests are not affected because browsers do not attach `Authorization` on their own.
- **Blocked users:** they cannot start a new session, and the API rejects every token or session they already hold. Revoking their old sessions when you add a "block user" endpoint is still a good idea (`/api/auth/token` will still hand an old session a JWT, which the API then rejects).
- `/api/test/*` only exist to verify authentication; remove or restrict them before a production release if you do not want them public.

## Allowed origins (CLIENT_URL and EXTRA_ALLOWED_ORIGINS)

Browsers may call this API only from origins in one list, `ALLOWED_ORIGINS` (`src/config/env.ts`): `CLIENT_URL`
(always, the production frontend) plus the optional, comma-separated `EXTRA_ALLOWED_ORIGINS`
(e.g. `EXTRA_ALLOWED_ORIGINS=http://localhost:3000` so a local frontend can use the deployed API). The same list feeds
CORS, Better Auth's `trustedOrigins` and the cookie-auth origin check (`403 ORIGIN_NOT_ALLOWED`).
Each entry must be an exact `http(s)` origin; `*`, wildcard hosts and other protocols make the server refuse to start.
Paths and trailing slashes are dropped. Leave it empty in production unless you need it. `npm run verify:origins` checks it.
