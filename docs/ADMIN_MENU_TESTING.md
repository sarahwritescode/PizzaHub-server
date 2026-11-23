# Admin menu approval and moderation (Task 06)

Base path: `/api/admin/menu-items`. Every endpoint needs `Authorization: Bearer <admin JWT>` (get it from
`GET /api/auth/token` after signing in; the Better Auth session cookie also works from the browser).

| Who | Result |
|---|---|
| Not signed in / bad token | 401 `NO_CREDENTIALS` / `INVALID_TOKEN` / `TOKEN_EXPIRED` |
| Customer or vendor | 403 `FORBIDDEN` |
| Blocked admin | 403 `ACCOUNT_BLOCKED` (checked on every request, so a token issued before the block stops working) |
| Admin | allowed |

Middleware order (all inside the existing `requireRole("admin")`): verify the JWT or session, load the user from the
database (role and `isBlocked` are never read from the token), refuse blocked users, check the role, then the controller.

All responses use the project's usual shape: `{ success: true, message, data, pagination? }` on success and
`{ success: false, message, code, errors? }` on failure. Public and vendor responses are unchanged.

## The admin item

Admins see the whole document (the public and vendor APIs hide `vendorId` and/or `status`), plus the owner:

```json
{
  "_id": "674a1b2c3d4e5f6a7b8c9d0e",
  "vendorId": "674a0000000000000000aaaa",
  "itemName": "Margherita Pizza",
  "category": "Pizza",
  "description": "Tomato, mozzarella, basil",
  "price": 450,
  "location": "Dhaka",
  "images": ["https://i.ibb.co/xxxx/pizza.jpg"],
  "status": "pending",
  "createdAt": "2026-11-22T10:15:30.000Z",
  "vendor": { "_id": "674a0000000000000000aaaa", "name": "Vendor A", "email": "vendora@example.com", "businessName": "Vendor A Kitchen" }
}
```

`vendor` has only those four fields (`businessName` is left out when the vendor never set one). It is `null` when the
vendor's account no longer exists; the item is still listed.

## Status rules (used by approve, reject and PATCH status alike)

| From | To | Allowed | Why |
|---|---|---|---|
| `pending` | `approved` | yes | approve |
| `pending` | `rejected` | yes | reject |
| `approved` | `inactive` | yes | take a live item off the public menu |
| `rejected` | anything | **no** | a rejected item comes back only when its vendor edits it (that sets it to `pending`) |
| `inactive` | `approved` | **no** | the vendor re-activates it, and the Free-plan limit (3 active items) is checked there; an admin shortcut would skip it |
| anything | `pending` | **no** | only a vendor edit sends an item back to `pending` |
| same status again | | **no** | "already approved" etc. |

A refused change is `409 INVALID_STATUS_TRANSITION` and the item is not touched. These are the rules the vendor API
already enforces (see [VENDOR_MENU_TESTING.md](VENDOR_MENU_TESTING.md)); nothing new was invented. The write itself only
succeeds while the item still has the status that was checked, so two admins acting at the same moment cannot both win
(the loser gets 409).

Approving never changes a vendor's Free-plan count (`pending` and `approved` both count as active).

**Rejection reason:** the `menuItems` schema has no field for it, so it is **not** accepted. Sending `reason` (or any
other field) to `/reject` or `/approve` is a `400` rather than being silently dropped. Adding a reason means a schema
change, which needs a decision first.

---

## A. List all menu items

`GET /api/admin/menu-items`

Query (all optional):

| Param | Meaning |
|---|---|
| `status` | `pending`, `approved`, `rejected` or `inactive` |
| `category` | exact match, ignoring case (`pizza` finds `Pizza`, not `Pizza Rolls`), like the public list |
| `search` | partial match on the **item name**, ignoring case. Max 100 characters; regex characters are literal text |
| `page` | default 1 |
| `limit` | default 12, max 50 |

Newest first (`createdAt` descending). Filters combine (AND). The total and the pages follow the filter.

```json
// 200
{ "success": true, "message": "Menu items fetched successfully",
  "data": [ { "...the admin item above..." } ],
  "pagination": { "page": 1, "limit": 12, "totalItems": 5, "totalPages": 1, "hasNextPage": false, "hasPreviousPage": false } }
```

Errors: 400 `VALIDATION_ERROR` (bad `status`, `page=0`, `limit=51`, a repeated key, ...), 401, 403.

### A2. List categories

`GET /api/admin/menu-items/categories`: the distinct categories over items of **every** status (pending, approved,
rejected, inactive), with how many items each has. No query and no body: any query parameter is a 400
`VALIDATION_ERROR`. Read-only.

```json
// 200
{ "success": true, "message": "Categories fetched successfully",
  "data": [ { "name": "Burgers", "count": 1 }, { "name": "Classic Pizzas", "count": 5 } ] }
```

* Sorted A-Z by `name`.
* Grouping ignores case and surrounding spaces: `Pizza`, `pizza` and `PIZZA` are one category. The name shown is the
  first spelling in alphabetical order (the same rule as the public list); blank categories are skipped.
* This is the admin view. The public `GET /api/categories` is unchanged and counts only approved items of unblocked
  vendors.
* The route is declared next to `GET /` (there is no `GET /:id`, so there is no clash).

Errors: 400 (any query parameter), 401, 403.

## B. Approve

`PATCH /api/admin/menu-items/:id/approve`, no body (`{}` is fine).

```json
// 200: the item is now approved and public
{ "success": true, "message": "Menu item approved. It is now visible on the public menu.", "data": { "...admin item...", "status": "approved" } }
```

Errors: 400 `VALIDATION_ERROR` (bad id, or a body field), 401, 403, 404 `MENU_ITEM_NOT_FOUND`, 409 `INVALID_STATUS_TRANSITION`:

```json
{ "success": false, "message": "This menu item is already approved.", "code": "INVALID_STATUS_TRANSITION" }
{ "success": false, "message": "Only a pending item can be approved (this one is rejected).", "code": "INVALID_STATUS_TRANSITION" }
```

## C. Reject

`PATCH /api/admin/menu-items/:id/reject`, no body.

```json
// 200
{ "success": true, "message": "Menu item rejected. The vendor can edit it to resubmit it for approval.", "data": { "...admin item...", "status": "rejected" } }
```

Errors as in B. 409 examples: `This menu item is already rejected.` and `Only a pending item can be rejected (this one is approved).`

## D. Change the status

`PATCH /api/admin/menu-items/:id/status`

```json
{ "status": "inactive" }
```

`status` must be one of `pending`, `approved`, `rejected`, `inactive` (anything else, a missing value or extra fields:
400 `VALIDATION_ERROR`). The change then has to be allowed by the table above, otherwise 409.

```json
// 200
{ "success": true, "message": "Menu item status changed to inactive", "data": { "...admin item...", "status": "inactive" } }
```

```json
// 400
{ "success": false, "message": "Validation failed", "code": "VALIDATION_ERROR",
  "errors": [ { "field": "status", "message": "Invalid option: expected one of \"pending\"|\"approved\"|\"rejected\"|\"inactive\"" } ] }
```

## E. Delete

`DELETE /api/admin/menu-items/:id`

```json
// 200
{ "success": true, "message": "Menu item deleted successfully", "data": { "_id": "674a1b2c3d4e5f6a7b8c9d0e" } }
```

- Any vendor's item, any status. There is no ownership check (an admin acts on all items).
- Same safety rule as the vendor's own delete: an item with an open order (`pending` or `accepted`) is refused with
  `409 ITEM_HAS_OPEN_ORDERS`. After the orders are finished or cancelled it can be deleted.
- Only the menu item is removed. Orders and users are not touched, and images are not deleted (they stay on ImgBB, which
  this API holds no delete handle for).
- Unknown id: `404 MENU_ITEM_NOT_FOUND`. Malformed id: `400 VALIDATION_ERROR`.

## Error codes

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | bad id (not 24 hex characters), bad query, bad or extra body field. `errors: [{ field, message }]` |
| 401 | `NO_CREDENTIALS`, `INVALID_TOKEN`, `TOKEN_EXPIRED` | not signed in |
| 403 | `FORBIDDEN` | signed in but not an admin |
| 403 | `ACCOUNT_BLOCKED` | blocked account |
| 403 | `ORIGIN_NOT_ALLOWED` | cookie-authenticated change from a foreign `Origin` (CSRF guard) |
| 404 | `MENU_ITEM_NOT_FOUND` | no item with that id |
| 409 | `INVALID_STATUS_TRANSITION` | the change is not allowed from the item's current status |
| 409 | `CONCURRENT_UPDATE` | the item changed while this request ran; try again |
| 409 | `ITEM_HAS_OPEN_ORDERS` | delete refused, open orders |
| 500 | (none) | `Internal server error`: database and other unexpected errors never expose details |

## Automated check (safe)

```bash
npm run verify:admin-menu
```

Real sign-ups, real Better Auth JWTs, real HTTP, real MongoDB, in a **throwaway database**
(`pizzahub_admenu_verify_<time>`, dropped at the end). Your real data is never touched. The admin (sign-up cannot create
one) and the blocked flag are set directly in that throwaway database. It covers: every endpoint for anonymous, customer,
vendor and blocked admin; the list (all vendors, all statuses, vendor info, newest first); every filter, pagination and
bad query; approve and reject (including repeating and the refused starting states); every one of the 16 status pairs;
invalid status bodies; malformed and unknown ids; delete (every status, open orders, no side effects); two admins at once;
and that the public and vendor APIs still behave as before.

## Postman

Import [postman/PizzaHub-AdminMenu.postman_collection.json](postman/PizzaHub-AdminMenu.postman_collection.json).

Use a demo database, never your real one:

1. `$env:DB_NAME = "pizzahub_admin_demo"; npm run dev` (the env var wins over `.env`).
2. Create the admin in that database: `$env:DB_NAME = "pizzahub_admin_demo"; npm run seed:admin` (needs the `ADMIN_*`
   values in `.env`). Put its email and password into the collection variables `adminEmail` and `adminPassword`.
3. In Postman open the Cookies manager and clear `localhost` cookies, then run the folders **in order** (Runner, or one
   by one). Folder 2 signs up a fresh vendor and customer with a new `runId`, signs the admin in, saves the three JWTs and
   creates three pending items; folders 3 to 9 use them. Folder 9 deletes them again, so the run can be repeated.
4. Afterwards drop `pizzahub_admin_demo` in Compass.

| # | Case | Folder |
|---|---|---|
| 1 | Admin sees all items | 4 |
| 2 | Customer refused | 3 |
| 3 | Vendor refused | 3 |
| 4 | Not signed in refused | 1 |
| 5 | Approve a pending item | 5 |
| 6 | Reject a pending item | 6 |
| 7 | Approve an approved item again | 5 (409) |
| 8 | Reject a rejected item again | 6 (409) |
| 9 | Invalid ObjectId | 8 (400) |
| 10 | Unknown id | 8 (404) |
| 11 | Invalid status | 7 (400) |
| 12 | Pagination and filters | 4 |

Not covered by Postman (use `npm run verify:admin-menu`): blocked admin, two admins at once, open orders, and the
refused status pairs other than the few in folder 7.

The collection's scripts were run with a small stand-in for Postman's `pm` object against the real app (110 checks
passed), not in Postman itself. `npm run verify:admin-menu` is the authoritative test.
