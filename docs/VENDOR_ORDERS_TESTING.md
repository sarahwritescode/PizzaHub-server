# Vendor order management (Task 08)

Base path: `/api/vendor/orders`. Every endpoint needs `Authorization: Bearer <vendor JWT>` (from `GET /api/auth/token` after
signing in; the Better Auth session cookie also works from the browser).

| Who | Result |
|---|---|
| Not signed in / bad token | 401 `NO_CREDENTIALS` / `INVALID_TOKEN` / `TOKEN_EXPIRED` |
| Customer or admin | 403 `FORBIDDEN` |
| Blocked vendor | 403 `ACCOUNT_BLOCKED` (checked on every request, so an old token stops working) |
| Vendor | allowed |

Middleware (the existing `requireRole("vendor")`): verify the JWT or session, load the user from the database (role and
`isBlocked` are never read from the token), refuse blocked users, check the role, then the controller. The vendor is always
the logged-in user; the body is never read for an id or a status. Responses use the project's shape:
`{ success, message, data, pagination? }` and, on failure, `{ success: false, message, code, errors? }`.

## Whose orders are these?

`order.vendorId` is copied from the menu item **when the customer places the order** (the client never sends it), so it is the
owner of the ordered item. Every query filters by it: another vendor's order is never listed, and for accept/reject it looks
exactly like a missing one (`404 ORDER_NOT_FOUND`, the project's ownership convention).

## The order object

Same field names and types as the order a **customer** gets ([CUSTOMER_ORDERS_TESTING.md](CUSTOMER_ORDERS_TESTING.md)), except
that `vendor` (that is you) is replaced by `customer`:

```json
{
  "_id": "674b1b2c3d4e5f6a7b8c9d0e",
  "itemId": "674a1b2c3d4e5f6a7b8c9d0e",
  "deliveryDate": "2026-12-01T00:00:00.000Z",
  "deliveryAddress": "House 1, Road 2, Dhaka",
  "message": "Extra cheese please",
  "status": "pending",
  "createdAt": "2026-11-22T14:10:00.000Z",
  "item":     { "_id": "674a1b2c3d4e5f6a7b8c9d0e", "itemName": "Margherita Pizza", "category": "Pizza", "price": 450, "location": "Dhaka", "images": ["https://i.ibb.co/xxxx/pizza.jpg"] },
  "customer": { "_id": "674a0000000000000000bbbb", "name": "Rahim" }
}
```

- `customer` is only `_id` and `name`. **No email, phone, role, plan, flags or tokens.** The delivery address is on the order.
- `message` is left out when there is none. `item` / `customer` are `null` if that document no longer exists.
- `customerId` and `vendorId` are not in the response.

## A. List my orders

`GET /api/vendor/orders?status=&page=1&limit=12`

| Param | Meaning |
|---|---|
| `status` | optional: `pending`, `accepted`, `rejected` or `cancelled` |
| `page` | default 1 |
| `limit` | default 12, max 50 |

Newest first. The total and the pages follow the filter. Bad values (unknown status, `page=0`, `limit=51`, a repeated key):
400 `VALIDATION_ERROR`.

```json
// 200
{ "success": true, "message": "Your orders fetched successfully", "data": [ { "...order..." } ],
  "pagination": { "page": 1, "limit": 12, "totalItems": 7, "totalPages": 1, "hasNextPage": false, "hasPreviousPage": false } }
```

## B. Accept

`PATCH /api/vendor/orders/:id/accept`, no body (`{}` is fine, any field is a 400).

```json
// 200
{ "success": true, "message": "Order accepted successfully", "data": { "...order...", "status": "accepted" } }
```

## C. Reject

`PATCH /api/vendor/orders/:id/reject`, no body.

```json
// 200
{ "success": true, "message": "Order rejected successfully", "data": { "...order...", "status": "rejected" } }
```

After a rejection the same customer may order the same item for the same day again (see below).

## Errors (accept and reject)

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | malformed id (not 24 hex characters), or a body field |
| 401 / 403 | `NO_CREDENTIALS`, `INVALID_TOKEN`, `TOKEN_EXPIRED` / `FORBIDDEN`, `ACCOUNT_BLOCKED` | not an allowed vendor |
| 404 | `ORDER_NOT_FOUND` | no such order, **or not for one of your items** (same answer for both) |
| 409 | `INVALID_STATUS_TRANSITION` | the order is not `pending` |

```json
{ "success": false, "message": "Order not found", "code": "ORDER_NOT_FOUND" }
{ "success": false, "message": "This order is already accepted.", "code": "INVALID_STATUS_TRANSITION" }
{ "success": false, "message": "Only a pending order can be rejected (this one is cancelled).", "code": "INVALID_STATUS_TRANSITION" }
```

## Status rules

| Order is | Accept | Reject | Customer cancel |
|---|---|---|---|
| `pending` | 200 | 200 | 200 |
| `accepted` | 409 | 409 | 409 |
| `rejected` | 409 | 409 | 409 |
| `cancelled` | 409 | 409 | 409 |

Only a `pending` order can be decided. There is no way back (an accepted order cannot be cancelled by the customer, a
rejected one is not reopened); the customer simply orders again.

## Concurrency

Accept, reject and the customer's cancel all go through one function (`moveOrderFromPending` in `order.service.ts`): a single
conditional write, `updateOne({ _id, <owner>, status: "pending" }, { $set: { status } })`. MongoDB evaluates it atomically, so
when several of them hit the same pending order at the same moment **exactly one matches**; the others get `409
INVALID_STATUS_TRANSITION` and the stored status is the winner's. The customer cancel and the vendor decisions share this
code on purpose: the rule exists once.

## Interaction with the customer's duplicate-order index

`orders_active_customer_item_date_uidx` (unique on `itemId, customerId, deliveryDate`, only for `pending` / `accepted`
orders) is **not changed**:

- `pending` to `accepted`: the order stays in the index, so a duplicate for that day is still refused (409 `DUPLICATE_ORDER`).
- `pending` to `rejected` (or `cancelled`): the order leaves the index, so the customer can place a new order for the same
  item and day (201). That new order is `pending` and blocks further duplicates again.

## Automated check (safe)

```bash
npm run verify:vendor-orders
```

Real sign-ups, real Better Auth JWTs, real HTTP, real MongoDB, in a **throwaway database**
(`pizzahub_vorders_verify_<time>`, dropped at the end). Your real data is never touched. Orders are placed through the real
customer API; only the admin and the blocked flag are set directly in that database. It covers all 17 cases of the task plus
the shape of the responses (and that the customer API's responses are unchanged), privacy, mass assignment, the index, and
**12 rounds of accept + reject + cancel (twice each) fired at one pending order at once**: exactly one wins every time, the
stored status is the winner's, all others get 409.

## Postman

Import [postman/PizzaHub-VendorOrders.postman_collection.json](postman/PizzaHub-VendorOrders.postman_collection.json).

Use a demo database, never your real one:

1. `$env:DB_NAME = "pizzahub_vorders_demo"; npm run dev` (the env var wins over `.env`).
2. Create the admin in that database (needed to approve the items): `$env:DB_NAME = "pizzahub_vorders_demo"; npm run seed:admin`
   (needs the `ADMIN_*` values in `.env`), then put its email and password into the collection variables `adminEmail` /
   `adminPassword`.
3. In Postman open the Cookies manager, clear `localhost` cookies, then run the folders **in order**. Folder 2 signs up two
   vendors and two customers with a new `runId`, saves the JWTs, creates and approves one item per vendor and places five
   pending orders (delivery days are computed, 21 to 26 days from today, so the collection never goes stale).
4. Afterwards drop `pizzahub_vorders_demo` in Compass.

| # | Case | Folder |
|---|---|---|
| 1 | Vendor sees their own orders | 4 |
| 2 | Another vendor's orders are not shown | 4 |
| 3 | Customer refused | 3 |
| 4 | Admin refused | 3 |
| 5 | Not signed in | 1 |
| 6 | Blocked vendor | `npm run verify:vendor-orders` (needs the DB flag) |
| 7 | Accept a pending order | 5 |
| 8 | Reject a pending order | 6 |
| 9 | Another vendor cannot accept / reject | 7 (404) |
| 10 | Accept an accepted order | 5 (409) |
| 11 | Reject a rejected order | 6 (409) |
| 12 | Accept / reject a cancelled order | 7 (409) |
| 13 | Invalid ObjectId | 8 (400) |
| 14 | Unknown order | 8 (404) |
| 15 | Pagination and status filter | 4 |
| 16 | Concurrent accept / reject / cancel | `npm run verify:vendor-orders` (needs parallel requests) |
| 17 | Customer orders again after a rejection | 6 |

The collection's scripts were run with a small stand-in for Postman's `pm` object against the real app (101 checks passed),
not in Postman itself. `npm run verify:vendor-orders` is the authoritative test.
