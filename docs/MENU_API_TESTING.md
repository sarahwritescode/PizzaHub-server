# Public Menu API (Task 03)

No login is needed for any of these endpoints.

| Endpoint | Purpose |
|---|---|
| `GET /api/menu-items` | Public list with search, filters, sorting, pagination |
| `GET /api/menu-items/featured` | Up to 6 public items for the homepage: active Premium vendors' items first, then the newest |
| `GET /api/menu-items/:id` | One public item |
| `GET /api/categories` | Unique categories of public items, with counts |

## What "public" means

An item is public when **`status === "approved"`**. The `menuItems` schema has no separate
"active" field: `inactive` is one of the `status` values, so requiring `approved` already hides
`pending`, `rejected` and `inactive` items. No new field was added.

Public responses contain only `_id, itemName, category, description, price, location, images, createdAt, vendor`.
`vendorId` and `status` are never returned.

### The `vendor` field

Every public item (list, featured, single) has a `vendor` object, exactly these three keys:

```json
"vendor": { "name": "Alpha Owner", "businessName": "Alpha Kitchen", "isPremium": true }
```

| Key | Meaning |
|---|---|
| `name` | The vendor's name |
| `businessName` | The vendor's business name, `null` when they have none |
| `isPremium` | The **effective** Premium state. `true` only while the paid period has not run out. A Free vendor, an **expired** Premium, and a Premium without an expiry date are all `false` (the same rule as `GET /api/vendor/subscription`) |

* **Never exposed:** the vendor's id (there is no `vendorId` and the vendor has no `_id`), email, role, blocked flag,
  plan dates, and any Stripe or subscription data. Only `name`, `businessName`, `subscriptionPlan` and
  `subscriptionExpiresAt` are read from `users`, and the last two are used only to compute `isPremium`.
* `vendor` is `null` when the vendor's account no longer exists (the item is still listed).
* One extra query per page loads all vendors of the page; there is no query per item.
* The state is read on every request: when a Premium period runs out, `isPremium` turns `false` immediately.
* Items of a **blocked** vendor stay hidden, as before.

### Premium first in `/featured`

`GET /api/menu-items/featured` returns up to 6 items: first the approved items of vendors whose Premium is **active**
(newest first), then, to fill the 6, the newest approved items of everyone else. Only `/featured` does this: the normal
list (`/api/menu-items`) keeps the sort the caller asked for (`sortBy` / `order`), so pagination is not affected.

## Query parameters of `GET /api/menu-items`

| Parameter | Rule | Default |
|---|---|---|
| `search` | Case-insensitive "contains" on itemName, description, category **or** location. Max 100 chars | none |
| `category` | Case-insensitive **exact** match (`chicken` finds `Chicken`, not `Chicken Wings`) | none |
| `location` | Case-insensitive "contains" (`dhaka` finds `Dhaka, Bangladesh`) | none |
| `sortBy` | `price` or `createdAt` | `createdAt` |
| `order` | `asc` or `desc` | `desc` (newest first) |
| `page` | whole number 1 to 100000 | `1` |
| `limit` | whole number 1 to 50 | `12` |

Everything runs inside MongoDB (`find` + `sort` + `skip` + `limit`, and `countDocuments` with the
same filter). Search text is regex-escaped, so `.*` or `(` are plain characters.

Invalid values are **rejected with 400** (never silently changed): `page=0`, `page=abc`, `limit=51`,
`sortBy=name`, `order=up`, a repeated key such as `?search=a&search=b`, or a search longer than 100 chars.

Notes:
- Items with an equal price/date are ordered by `_id` as a tie-breaker, so no item is repeated or lost between pages.
- `/api/categories` treats `Chicken` and `chicken` as one category (shown with the first spelling alphabetically).
- A page past the end (`page=99`) returns `200` with `data: []`.

## Responses

List (`pagination` is only in the list):

```json
{
  "success": true,
  "message": "Menu items fetched successfully",
  "data": [
    {
      "_id": "6b01c8cbe415cec94acdf218",
      "itemName": "Margherita Pizza",
      "category": "Pizza",
      "description": "Classic tomato and cheese",
      "price": 400,
      "location": "Dhaka",
      "images": ["https://example.com/margherita.jpg"],
      "createdAt": "2026-01-20T10:00:00.000Z",
      "vendor": { "name": "Alpha Owner", "businessName": "Alpha Kitchen", "isPremium": false }
    }
  ],
  "pagination": { "page": 1, "limit": 12, "totalItems": 1, "totalPages": 1, "hasNextPage": false, "hasPreviousPage": false }
}
```

Single item and featured: same item shape, `message` is "Menu item fetched successfully" /
"Featured menu items fetched successfully", and there is no `pagination`.

Categories:

```json
{ "success": true, "message": "Categories fetched successfully", "data": [ { "name": "Chicken", "count": 3 }, { "name": "Pizza", "count": 1 } ] }
```

Errors use the same shape as the rest of the API (`success: false`, `message`) plus `code`, and `errors` for validation:

```json
// 400  GET /api/menu-items/INVALID_ID
{ "success": false, "message": "Validation failed", "code": "VALIDATION_ERROR",
  "errors": [ { "field": "id", "message": "Must be a valid MongoDB ObjectId (24 hex characters)" } ] }

// 404  valid id, but missing / pending / rejected / inactive
{ "success": false, "message": "Menu item not found", "code": "MENU_ITEM_NOT_FOUND" }
```

A pending/rejected/inactive item answers exactly like a missing one, so nothing leaks.

## Automated check (safe)

```bash
npm run verify:menu
```

Starts the real app on a random port, creates a **throwaway database** (`pizzahub_menu_verify_<time>`),
inserts approved/pending/rejected/inactive items there, calls every endpoint over HTTP, then drops the
throwaway database. Your real data is never touched. 122 checks, including the vendor field:

* `vendor` has exactly `name`, `businessName`, `isPremium` in the list, in `/featured` and in the single item
* no email, `vendorId`, role, blocked flag, plan date or Stripe text anywhere in those responses
* Free vendor `isPremium: false`, active Premium `true`, **expired** Premium `false`, Premium without an expiry date `false`,
  missing vendor account `vendor: null`
* `/featured` puts the active Premium vendor's items first (newest of them first) even though they are older, then the
  newest of everyone else; the normal list and the price sort are not reordered
* the state follows the data live (Premium running out, a vendor becoming Premium), and a blocked Premium vendor's items stay hidden

## Test data for manual / Postman testing

Postman needs some `approved` items to exist. Do **not** add fake items to your real `pizzahub` database.
Use a separate demo database instead:

1. Start the server against a demo database (the env var wins over `.env`):

   ```powershell
   $env:DB_NAME = "pizzahub_menu_demo"; npm run dev
   ```

   On start-up the server creates the `menuItems` collection (with its validator and indexes) in that database.
2. In MongoDB Compass open `pizzahub_menu_demo` → `menuItems` → **Add Data → Import JSON or CSV** →
   choose [docs/menu-demo-data.json](menu-demo-data.json). It has 6 approved items and one each of
   pending / rejected / inactive.
3. When finished, drop the `pizzahub_menu_demo` database in Compass (or just stop using it).

To test against real data instead, no setup is needed: the vendors' approved items are simply returned.

## Postman

Import [docs/postman/PizzaHub-Menu.postman_collection.json](postman/PizzaHub-Menu.postman_collection.json)
and set `baseUrl` (default `http://localhost:5000`). Run top to bottom: request 1 saves an item id that
request 10 uses. Requests 1–12 are the twelve calls from the task, "Extra checks" covers invalid values,
404 and regex characters. Each request has test scripts; the expectations assume the demo data above,
or any data that has at least one approved item.

Manual equivalents:

```bash
curl "http://localhost:5000/api/menu-items?search=pizza&category=chicken&sortBy=price&order=asc&page=1&limit=12"
curl "http://localhost:5000/api/menu-items/featured"
curl "http://localhost:5000/api/categories"
curl "http://localhost:5000/api/menu-items/INVALID_ID"
```

## Performance notes

- List, count and sort use the existing indexes only (`status + createdAt`, `category + status`, `price`);
  no index was added and the schema is unchanged.
- Case-insensitive regex searches scan the approved items rather than use an index. That is fine for a menu
  of up to a few thousand items. If the menu grows much larger, the next step is a MongoDB text index or Atlas Search.
