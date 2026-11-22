# Customer orders (Task 07)

Base path: `/api/orders`. Every endpoint needs `Authorization: Bearer <customer JWT>` (from `GET /api/auth/token` after
signing in; the Better Auth session cookie also works from the browser).

| Who | Result |
|---|---|
| Not signed in / bad token | 401 `NO_CREDENTIALS` / `INVALID_TOKEN` / `TOKEN_EXPIRED` |
| Vendor or admin | 403 `FORBIDDEN` |
| Blocked customer | 403 `ACCOUNT_BLOCKED` (checked on every request, so an old token stops working) |
| Customer | allowed |

Middleware (the existing `requireRole("customer")`): verify the JWT or session, load the user from the database (role and
`isBlocked` are never read from the token), refuse blocked users, check the role, then the controller. The customer is
always the logged-in user. Responses use the project's shape: `{ success, message, data, pagination? }` and, on failure,
`{ success: false, message, code, errors? }`. No other API's response changed.

## The order object

```json
{
  "_id": "674b1b2c3d4e5f6a7b8c9d0e",
  "itemId": "674a1b2c3d4e5f6a7b8c9d0e",
  "deliveryDate": "2026-12-01T00:00:00.000Z",
  "deliveryAddress": "House 1, Road 2, Dhaka",
  "message": "Extra cheese please",
  "status": "pending",
  "createdAt": "2026-11-22T14:10:00.000Z",
  "item":   { "_id": "674a1b2c3d4e5f6a7b8c9d0e", "itemName": "Margherita Pizza", "category": "Pizza", "price": 450, "location": "Dhaka", "images": ["https://i.ibb.co/xxxx/pizza.jpg"] },
  "vendor": { "_id": "674a0000000000000000aaaa", "name": "Vendor A", "businessName": "Pizza Palace" }
}
```

- `status`: `pending`, `accepted`, `rejected` or `cancelled`. A customer can only cancel; accepting and rejecting is the
  vendor's job (a later task).
- `message` is left out when there is none. `businessName` is left out when the vendor never set one.
- `item` / `vendor` are `null` if that document no longer exists (an item can be deleted after its orders are finished);
  the order stays readable.
- **Not in the response:** `customerId` (it is you), `vendorId` (use `vendor._id`), any email, role, plan or other private field.
- `deliveryDate` is the chosen day at 00:00 UTC. Show it as a date, not a time.

## A. Create an order

`POST /api/orders`

```json
{ "itemId": "674a1b2c3d4e5f6a7b8c9d0e", "deliveryDate": "2026-12-01", "deliveryAddress": "House 1, Road 2, Dhaka", "message": "Optional" }
```

| Field | Rule |
|---|---|
| `itemId` | required, 24-hex ObjectId |
| `deliveryDate` | required, `YYYY-MM-DD`, a real calendar day, today or later. A time of day (`...T10:00`) is refused |
| `deliveryAddress` | required, trimmed, 1 to 300 characters |
| `message` | optional, max 500 characters; missing, empty or blank all mean "none" |

**Any other field is refused with 400** (`customerId`, `vendorId`, `status`, `createdAt`, `_id`, `price`, ...). The vendor
comes from the menu item, the customer from the login, the status is always `pending`.

```json
// 201
{ "success": true, "message": "Order placed successfully. It is waiting for the vendor.", "data": { "...order..." } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | bad or missing field, extra field, past date, bad JSON. `errors: [{ field, message }]` |
| 403 | `CANNOT_ORDER_OWN_ITEM` | the item belongs to you |
| 404 | `MENU_ITEM_NOT_FOUND` | no item with that id |
| 409 | `MENU_ITEM_UNAVAILABLE` | the item exists but is not `approved` (pending, rejected or inactive; the message does not say which) |
| 409 | `DUPLICATE_ORDER` | you already have an active (`pending` or `accepted`) order for this item on that day |

```json
{ "success": false, "message": "You already have an active order for this item on that delivery date.", "code": "DUPLICATE_ORDER" }
```

**Duplicates.** "Active" = `pending` or `accepted`. After a cancel or a vendor rejection the same item and day can be
ordered again. Another day, another item, or another customer is always fine.

**Race safety.** The existing index on `orders` (`itemId, customerId, deliveryDate, status`) is not unique, so it cannot
stop two parallel requests. Task 07 adds the unique **partial** index `orders_active_customer_item_date_uidx` on
`{ itemId, customerId, deliveryDate }`, limited to `status` in `pending`/`accepted`. MongoDB itself lets exactly one of
several simultaneous identical requests in; the others get `DUPLICATE_ORDER`. It is created on server start, like the other
indexes, and never deletes anything. If your database already holds two active duplicates, the index is **not** created, a
problem is logged at start-up, and nothing is deleted: fix the duplicates and restart.

## B. My orders

`GET /api/orders/my-orders?page=1&limit=12`

Only your orders, newest first. `page` default 1, `limit` default 12, max 50 (bad values: 400 `VALIDATION_ERROR`).

```json
// 200
{ "success": true, "message": "Your orders fetched successfully", "data": [ { "...order..." } ],
  "pagination": { "page": 1, "limit": 12, "totalItems": 5, "totalPages": 1, "hasNextPage": false, "hasPreviousPage": false } }
```

## C. One order

`GET /api/orders/:id`

```json
// 200
{ "success": true, "message": "Order fetched successfully", "data": { "...order..." } }
```

- Malformed id: 400 `VALIDATION_ERROR`.
- Not found **or someone else's order**: 404 `ORDER_NOT_FOUND`, the same answer for both, so order ids of other customers are
  not revealed (this is the project's convention, also used for vendor ownership).

```json
{ "success": false, "message": "Order not found", "code": "ORDER_NOT_FOUND" }
```

## D. Cancel

`PATCH /api/orders/:id/cancel`, no body (`{}` is fine, any field is a 400).

```json
// 200
{ "success": true, "message": "Order cancelled successfully", "data": { "...order...", "status": "cancelled" } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | malformed id, or a body field |
| 404 | `ORDER_NOT_FOUND` | no such order, or not yours |
| 409 | `INVALID_STATUS_TRANSITION` | already cancelled, or `accepted` / `rejected` (`Only a pending order can be cancelled (this one is accepted).`) |

The write only succeeds while the order is still `pending`, so two cancels at once cancel once, and a cancel racing a vendor
accept cannot both win.

## Automated check (safe)

```bash
npm run verify:customer-orders
```

Real sign-ups, real Better Auth JWTs, real HTTP, real MongoDB, in a **throwaway database**
(`pizzahub_orders_verify_<time>`, dropped at the end). Your real data is never touched. The admin and the blocked flag are
set directly in that database, items are inserted directly so every status exists, and an order is moved to `accepted`
directly because there is no vendor order API yet. It covers all 21 cases of the task plus the index (also by inserting a
duplicate straight into MongoDB), parallel requests, mass assignment, privacy of the responses and that the other APIs are
unchanged.

## Postman

Import [postman/PizzaHub-CustomerOrders.postman_collection.json](postman/PizzaHub-CustomerOrders.postman_collection.json).

Use a demo database, never your real one:

1. `$env:DB_NAME = "pizzahub_orders_demo"; npm run dev` (the env var wins over `.env`).
2. Create the admin in that database (needed to approve the item): `$env:DB_NAME = "pizzahub_orders_demo"; npm run seed:admin`
   (needs the `ADMIN_*` values in `.env`) and put its email and password into the collection variables `adminEmail` /
   `adminPassword`.
3. In Postman open the Cookies manager, clear `localhost` cookies, then run the folders **in order**. Folder 2 signs up two
   customers and a vendor with a new `runId`, saves their JWTs, makes two items and has the admin approve one. The delivery
   days are computed (10, 11 and 12 days from today), so the collection never goes stale. Folder 7 cancels everything it
   created.
4. Afterwards drop `pizzahub_orders_demo` in Compass.

| # | Case | Folder |
|---|---|---|
| 1 | Customer creates an order | 4 |
| 2 | Vendor cannot order | 3 |
| 3 | Admin cannot order | 3 |
| 4 | Not signed in | 1 |
| 5 | Blocked customer | `npm run verify:customer-orders` (needs the DB flag) |
| 6 | Item does not exist | 4 (404) |
| 7 | Pending item | 4 (409). Rejected / inactive: `npm run verify:customer-orders` |
| 8 | Rejected item | `npm run verify:customer-orders` |
| 9 | Inactive item | `npm run verify:customer-orders` |
| 10 | Own vendor item | `npm run verify:customer-orders` (needs a user who is both) |
| 11 | Duplicate active order | 4 (409) |
| 12 | Invalid item id | 5 |
| 13 | Invalid delivery date | 5 |
| 14 | See my orders | 6 |
| 15 | Cannot see others' orders | 6 |
| 16 | My order details | 6 |
| 17 | Others' order details | 6 (404) |
| 18 | Cancel a pending order | 7 |
| 19 | Cannot cancel an accepted order | `npm run verify:customer-orders` (needs the DB to accept it) |
| 20 | Unknown order | 6, 7 (404) |
| 21 | Pagination | 6 |

The collection's scripts were run with a small stand-in for Postman's `pm` object against the real app (91 checks passed),
not in Postman itself. `npm run verify:customer-orders` is the authoritative test.
