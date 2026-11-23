# Admin management APIs (Task 10)

Dashboard, user management (list, details, block, unblock) and read-only transactions. The admin **menu** moderation
API (Task 06) is documented in [ADMIN_MENU_TESTING.md](ADMIN_MENU_TESTING.md) and is unchanged.

| Endpoint | What |
|---|---|
| `GET /api/admin/dashboard` | Counts of users, menu items, orders, transactions, active Premium vendors, plus the 5 newest of each |
| `GET /api/admin/users` | Paginated list. Query: `search`, `role`, `status`, `page`, `limit` |
| `GET /api/admin/users/:id` | One user's safe profile |
| `PATCH /api/admin/users/:id/block` | Block a user |
| `PATCH /api/admin/users/:id/unblock` | Unblock a user |
| `GET /api/admin/transactions` | Paginated, read-only. Query: `status`, `vendorId`, `page`, `limit` |

Every endpoint needs `Authorization: Bearer <admin JWT>` (`GET /api/auth/token` after signing in; the Better Auth session
cookie also works from the browser). Nothing new was added to authentication: all three routers use the existing
`requireRole("admin")` (verify JWT/session, load the user from the database, refuse blocked users, check the role).

| Who | Result |
|---|---|
| Not signed in / bad token | 401 `NO_CREDENTIALS` / `INVALID_TOKEN` / `TOKEN_EXPIRED` |
| Customer or vendor | 403 `FORBIDDEN` |
| Blocked admin | 403 `ACCOUNT_BLOCKED` |
| Admin | allowed |

Responses use the project's existing shape: `{ success: true, message, data, pagination? }` and
`{ success: false, message, code, errors? }`. The existing shape was kept (it is what every earlier API and the
frontend already use); there is no separate `error` field.

## Dashboard

```json
{
  "success": true,
  "message": "Dashboard fetched successfully",
  "data": {
    "users": { "total": 8, "customers": 3, "vendors": 2, "admins": 3, "blocked": 1 },
    "menuItems": { "total": 7, "pending": 2, "approved": 3, "rejected": 1, "inactive": 1 },
    "orders": { "total": 6, "pending": 2, "accepted": 1, "rejected": 1, "cancelled": 2 },
    "transactions": { "total": 6, "success": 2, "pending": 1, "failed": 1, "cancelled": 1, "expired": 1 },
    "subscriptions": { "activePremiumVendors": 1 },
    "recent": { "users": [], "orders": [], "transactions": [] }
  }
}
```

* Every number is counted in MongoDB at request time (aggregation pipelines). Nothing is cached or hard-coded; a status
  with no documents is `0`.
* `activePremiumVendors` = vendors with `subscriptionPlan: "premium"` **and** `subscriptionExpiresAt` in the future, the
  same rule the menu and subscription APIs use. An expired plan, or a non-vendor, is not counted.
* `recent.users` are in the user list shape below. `recent.orders` have only `_id, itemId, vendorId, customerId,
  status, deliveryDate, createdAt` (no delivery address or message). `recent.transactions` are in the transaction shape below.

## Users

```json
{
  "_id": "674a0000000000000000aaaa",
  "name": "Vendor Beta",
  "email": "vendorb@example.com",
  "role": "vendor",
  "image": null,
  "businessName": "Beta Kitchen",
  "isBlocked": false,
  "subscriptionPlan": "premium",
  "subscriptionExpiresAt": "2026-12-23T10:00:00.000Z",
  "createdAt": "2026-11-22T10:15:30.000Z"
}
```

* **Allow-list**: only these fields are read from `users`. Password hashes live in Better Auth's `account` collection and
  sessions in `session`; neither is read. Stripe customer/subscription ids stored on the user are not returned either.
* `subscriptionPlan` is the **effective** plan (as in `GET /api/vendor/subscription`): `premium` only while the paid
  period has not run out. `image`, `businessName` and `subscriptionExpiresAt` are `null` when missing.
* List: newest first, `search` matches name or email (case-insensitive, plain text, never a regex), `role` is
  `customer | vendor | admin`, `status` is `blocked | unblocked` (a user with no `isBlocked` field counts as unblocked),
  `page` >= 1, `limit` 1 to 50 (default 12). Anything else, or a repeated parameter, is `400 VALIDATION_ERROR`.
* `:id` that is not 24 hex characters is `400 VALIDATION_ERROR`; a valid id that does not exist is `404 USER_NOT_FOUND`.

### Block / unblock policy

| Case | Result |
|---|---|
| Block a customer or vendor | 200, `data` is the updated user (`isBlocked: true`) |
| Block **yourself** | 403 `CANNOT_BLOCK_SELF` |
| Block **another admin** | 403 `CANNOT_BLOCK_ADMIN` |
| Block someone already blocked | 409 `ALREADY_BLOCKED` |
| Unblock someone not blocked | 409 `ALREADY_UNBLOCKED` |
| Unknown user / invalid id | 404 `USER_NOT_FOUND` / 400 `VALIDATION_ERROR` |
| Any body field (`reason`, `role`, `isBlocked`...) | 400 `VALIDATION_ERROR`, nothing changes |

Why admins cannot be blocked: neither the assignment nor the existing authorization rules mention blocking an admin.
Admin accounts exist only through `npm run seed:admin`, and no endpoint can create, promote or restore one. If an
admin could block another admin (or a stolen admin token could), the result could not be undone through the API and
could lock every admin out. So the safe, consistent rule is: admins are never blocked through the API. Unblocking has
no such limit (it only gives access back).

What a block does:

* sets `isBlocked: true` and deletes the user's Better Auth sessions (`internalAdapter.deleteUserSessions`);
* takes effect on the **next request**: `requireAuth` reads `isBlocked` from the database on every request, so JWTs and
  cookies issued earlier are refused with `403 ACCOUNT_BLOCKED`; a blocked user also cannot sign in;
* **deletes nothing**: the user, their menu items, orders and transactions stay as they are;
* the write only matches while the user still has the opposite state, so two admins acting at the same moment cannot
  both succeed (one gets 409).

## Transactions

```json
{
  "_id": "674a1111111111111111aaaa",
  "vendorId": "674a0000000000000000aaaa",
  "vendor": { "_id": "674a0000000000000000aaaa", "name": "Vendor Beta", "email": "vendorb@example.com" },
  "plan": "premium",
  "amount": 9.99,
  "currency": "usd",
  "status": "success",
  "stripeSessionId": "cs_test_...",
  "stripeSubscriptionId": "sub_...",
  "createdAt": "2026-11-22T10:15:30.000Z"
}
```

* **Read-only.** There is exactly one route (`GET /api/admin/transactions`); POST, PUT, PATCH, DELETE and `GET /:id` are
  404. Transactions change only through the verified Stripe webhook.
* `status` is `pending | success | failed | cancelled | expired`; `vendorId` is a 24-hex ObjectId (an unknown but valid
  one gives an empty list); newest first; the same paging as above.
* `stripeSessionId` and `stripeSubscriptionId` are Stripe object references an admin needs to find a payment in the Stripe
  Dashboard; they are not secrets and give no access to card data. A transaction holds no card details, keys or
  customer data, and the response never contains the Stripe customer id.
* `vendor` has only `_id, name, email` (+ `businessName` if set). It is `null` when the vendor's account no longer exists.
* The amount is in major units (9.99, not 999 cents), as stored by the Stripe webhook.

## Automated test

```
npm run verify:admin
```

Real sign-up, real Better Auth JWTs, real HTTP, in a throwaway MongoDB database (`pizzahub_admin_verify_<time>`, dropped
at the end; your data is never touched). 156 checks, including:

1. every endpoint: anonymous 401, customer 403, vendor 403, blocked admin 403, bad token 401, cookie CSRF guard
2. user list: safe fields only, newest first, 3-page pagination, search by name and email (and `.*` is not a regex),
   role and blocked filters, combined filters, a user without `isBlocked`
3. ten invalid query values, all `400 VALIDATION_ERROR`
4. user details, expired Premium shown as free, invalid ids 400, unknown ids 404
5. block and unblock: old token refused, session cookie refused, sessions deleted, cannot sign in, user/order/item still
   exist, can sign in after unblock, repeated block/unblock 409, body refused, 3 parallel blocks (one 200, two 409)
6. self-block and admin-block refused, role cannot be changed
7. transaction list, status and vendor filters, pagination, validation, orphaned vendor
8. POST/PUT/PATCH/DELETE on transactions are 404 and the collection is unchanged byte for byte
9. dashboard counts match the database, expired/non-vendor Premium not counted, numbers update live, empty database gives zeros
10. health, public menu, admin menu, vendor, order APIs unchanged

## Manual check (Postman / curl)

```
GET  {{baseUrl}}/api/admin/dashboard                          Authorization: Bearer <admin JWT>
GET  {{baseUrl}}/api/admin/users?role=vendor&status=unblocked&search=pizza&page=1&limit=10
GET  {{baseUrl}}/api/admin/users/<userId>
PATCH {{baseUrl}}/api/admin/users/<userId>/block
PATCH {{baseUrl}}/api/admin/users/<userId>/unblock
GET  {{baseUrl}}/api/admin/transactions?status=success&vendorId=<vendorId>
```

After blocking, call any protected API with the blocked user's old token: it must return `403 ACCOUNT_BLOCKED`.
