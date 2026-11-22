# Vendor Menu API (Task 04)

Every endpoint needs a signed-in, non-blocked user with role **vendor**
(`Authorization: Bearer <JWT>`, see [AUTH_TESTING.md](AUTH_TESTING.md)).
Anonymous: 401. Customer or admin: 403 `FORBIDDEN`. Blocked vendor: 403 `ACCOUNT_BLOCKED`.

| Endpoint | Purpose |
|---|---|
| `GET /api/vendor/menu-items` | My items, every status. `?status=pending\|approved\|rejected\|inactive`, `?page`, `?limit` (same rules as the public list) |
| `POST /api/vendor/menu-items` | Create. Always starts as `pending` |
| `PATCH /api/vendor/menu-items/:id` | Edit content (any subset of the fields) |
| `PATCH /api/vendor/menu-items/:id/availability` | Body `{ "isActive": true\|false }` |
| `DELETE /api/vendor/menu-items/:id` | Delete |

Body of create / update: `itemName` (max 100), `category` (max 50), `description` (max 1000),
`price` (number, > 0, max 1,000,000), `location` (max 100), `images` (1 to 10 `http(s)` URLs).
Create needs all six; update needs at least one. Any other key makes the request fail with 400.

## Ownership and protected fields

- `vendorId` is never read from the request. It is the id of the verified, database-loaded user.
- Every read, update, availability change and delete filters by `{ _id, vendorId }`.
  Someone else's item looks exactly like a missing one: **404 `MENU_ITEM_NOT_FOUND`** in both cases, so ids of other
  vendors' items are never revealed (403 would confirm that the id exists).
- The body schemas are strict. Sending `vendorId`, `status`, `createdAt`, `_id`, `role`, `subscriptionPlan`,
  `isActive` (on create/update) or any unknown field returns **400 `VALIDATION_ERROR`** and changes nothing.
- Only the six content fields are ever written (allow-list in the service).
- Responses contain `_id, itemName, category, description, price, location, images, status, createdAt`, no `vendorId`.
  (The id field is `_id`, like the public API, not `id`.)

## Status rules (there is no `isActive` field: availability is the `status`)

| Action | From | To | Notes |
|---|---|---|---|
| Create | none | `pending` | needs a free slot (Free plan) |
| Edit content | `pending` | `pending` | |
| Edit content | `approved` | **`pending`** | re-approval, hidden from the public menu until approved again |
| Edit content | `inactive` | **`pending`** | otherwise re-activating would publish unreviewed content; needs a free slot |
| Edit content | `rejected` | `pending` | resubmission; needs a free slot |
| Edit, same values as now | any | unchanged | "No changes", status is not touched |
| `isActive: false` | `approved` | `inactive` | hidden from the public menu |
| `isActive: true` | `inactive` | `approved` | needs a free slot (Free plan) |
| `isActive: true` | `pending` / `rejected` | refused, 409 `INVALID_STATUS_TRANSITION` | a vendor can never approve |
| `isActive: false` | `pending` / `rejected` | refused, 409 | |

A vendor can never set `approved` on anything except by switching back an item that was already approved
(`inactive` only ever comes from an approved item). Admin approval is a later task.
Delete: refused with 409 `ITEM_HAS_OPEN_ORDERS` while a `pending` or `accepted` order points at the item.

## Free and Premium limit

- **Active item = status `pending` or `approved`.** `rejected` and `inactive` do not count.
  Why pending counts: the limit is checked when the item is created, so a Free vendor can't queue unlimited pending
  items, and an admin approving `pending -> approved` never changes the count. This is a judgement call because the
  Assignment text was not available: to change it, edit `ACTIVE_STATUSES` in `src/services/vendorMenu.service.ts`.
- **Free: at most 3 active items.** Premium: unlimited.
- The check runs on **create**, **re-activating** an inactive item, and **resubmitting** a rejected/inactive item by editing it.
  Editing a pending/approved item does not change the count, so it is always allowed.
- **Premium** means `subscriptionPlan = "premium"` **and** `subscriptionExpiresAt` in the future, read from the database
  inside the transaction on every request. Expired, or premium without any date, is treated as Free. The plan is never
  taken from the request. Existing items of a lapsed vendor are kept; they just cannot add or re-activate more than 3.
- Breaking the limit returns **403 `FREE_PLAN_LIMIT_REACHED`**.

### Race conditions

Count-then-insert is a race (two parallel requests both count 2 and both insert). Create, update and availability each
run in a MongoDB **transaction** that first writes the vendor's own `users` document (`updatedAt` only). Two requests of
the same vendor therefore conflict, MongoDB aborts one, the driver retries it, and the retry counts again.
Different vendors do not block each other. `npm run verify:vendor` proves it: 10 parallel creates on the Free plan give
exactly 3 successes. (With the lock removed, the same test fails, which was checked.)
Needs MongoDB with transactions (Atlas always has them).

## Error codes

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | bad body / query / id (`errors: [{ field, message }]`) |
| 401 / 403 | `NO_CREDENTIALS`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `ACCOUNT_BLOCKED`, `FORBIDDEN` | see AUTH_TESTING.md |
| 403 | `FREE_PLAN_LIMIT_REACHED` | Free vendor already has 3 active items |
| 404 | `MENU_ITEM_NOT_FOUND` | missing, or not yours |
| 409 | `INVALID_STATUS_TRANSITION` | availability change not allowed from the current status |
| 409 | `ITEM_HAS_OPEN_ORDERS` | delete while orders are open |

## Sample responses

```json
// POST /api/vendor/menu-items  -> 201
{ "success": true,
  "message": "Menu item created successfully. It will be visible after admin approval.",
  "data": { "_id": "6b02…", "itemName": "Postman Pizza", "category": "Pizza", "description": "Tasty and hot",
            "price": 450, "location": "Dhaka", "images": ["https://example.com/a.jpg"],
            "status": "pending", "createdAt": "2026-11-21T22:00:00.000Z" } }

// GET /api/vendor/menu-items  -> 200  (same pagination block as the public list)
{ "success": true, "message": "Your menu items fetched successfully", "data": [ { "...": "...", "status": "approved" } ],
  "pagination": { "page": 1, "limit": 12, "totalItems": 1, "totalPages": 1, "hasNextPage": false, "hasPreviousPage": false } }

// PATCH on an approved item, content changed -> 200, now pending
{ "success": true, "message": "Menu item updated. It is pending approval again and hidden from the public menu until approved.",
  "data": { "...": "...", "status": "pending" } }

// PATCH .../availability { "isActive": false } -> 200
{ "success": true, "message": "Menu item deactivated and hidden from the public menu", "data": { "...": "...", "status": "inactive" } }

// DELETE -> 200
{ "success": true, "message": "Menu item deleted successfully", "data": { "_id": "6b02…" } }

// 4th item on the Free plan -> 403
{ "success": false, "message": "The Free plan allows at most 3 active menu items. Delete or switch off another item, or upgrade to Premium.",
  "code": "FREE_PLAN_LIMIT_REACHED" }

// someone else's item, or unknown -> 404
{ "success": false, "message": "Menu item not found", "code": "MENU_ITEM_NOT_FOUND" }

// protected field in the body -> 400
{ "success": false, "message": "Validation failed", "code": "VALIDATION_ERROR",
  "errors": [ { "field": "status", "message": "This field is not allowed" } ] }
```

## Automated check (safe)

```bash
npm run verify:vendor
```

Real sign-ups, real Better Auth JWTs, real HTTP, real transactions, in a **throwaway database**
(`pizzahub_vendor_verify_<time>`, dropped at the end). Your real data is never touched. It covers all 17 cases of the
task plus validation, protected fields, ownership, the status table above, the Free/Premium/expired rules, parallel
requests, open orders, and that the public menu API is unchanged.

## Safe test setup for manual / Postman testing

Do **not** test on your real `pizzahub` database. Use a demo database:

1. `$env:DB_NAME = "pizzahub_vendor_demo"; npm run dev` (the env var wins over `.env`; collections and indexes are created).
2. Admin for the "admin gets 403" request: with the same `DB_NAME` set, run `npm run seed:admin`
   (needs `ADMIN_*` in `.env`), then put its email/password in the collection variables `adminEmail` / `adminPassword`.
   Optional: without it only that one request fails.
3. Import [postman/PizzaHub-VendorMenu.postman_collection.json](postman/PizzaHub-VendorMenu.postman_collection.json).
   Open Postman's Cookies manager and clear `localhost` cookies, then run the folders **in order**:
   - 1 (no login), 2 (setup: signs up fresh vendors with a new `runId` each run, then saves their JWTs), 3, 4, 5, 6.
   - **Folder 7 needs a manual step** because the admin approval API does not exist yet. In MongoDB Compass (or mongosh)
     on `pizzahub_vendor_demo`, approve the item whose id is in the collection variable `itemId`:
     ```js
     db.menuItems.updateOne({ _id: ObjectId("<itemId>") }, { $set: { status: "approved" } })
     ```
     then run folder 7.
   - Folder 8, 9 (fresh Free vendor, exactly 3 then 403).
   - **Folder 10 needs a one-time DB setup** (run folder 2 once first so the two users exist):
     ```js
     db.users.updateOne({ email: "premium.vendor@pizzahub.test" },
       { $set: { subscriptionPlan: "premium", subscriptionExpiresAt: new Date(Date.now() + 30*24*3600*1000) } })
     db.users.updateOne({ email: "expired.vendor@pizzahub.test" },
       { $set: { subscriptionPlan: "premium", subscriptionExpiresAt: new Date(Date.now() - 24*3600*1000) } })
     ```
     Folder 10 can be re-run any time.
4. Afterwards drop `pizzahub_vendor_demo` in Compass.

| Task case | Where |
|---|---|
| 1 Customer on vendor API | folder 3 |
| 2 No login | folder 1 |
| 3 Vendor sees own items | folder 4 |
| 4, 5 Create, status pending | folder 4 |
| 6 Update own | folders 5, 7 |
| 7 Update another vendor's | folder 5 (404) |
| 8, 9 Delete own / another's | folder 8 |
| 10 Deactivate | folder 7 |
| 11 Vendor approving rejected/pending | folder 6 (pending, 409). Rejected: `npm run verify:vendor` |
| 12 Free limit | folder 9 |
| 13 Premium | folder 10 |
| 14 Expired Premium | folder 10 |
| 15 Invalid ObjectId | folders 5, 6, 8 |
| 16 Invalid body | folders 4, 5 |
| 17 Pending / inactive not public | folders 4, 7 |

The Postman collection's scripts were run with a small stand-in for Postman's `pm` object (117 checks passed), not in
Postman itself. `npm run verify:vendor` is the authoritative test.
