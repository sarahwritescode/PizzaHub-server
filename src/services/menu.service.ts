import type { Filter, ObjectId, Sort } from "mongodb";

import { menuItemsCollection, usersCollection, type MenuItemDoc } from "../models/index.js";
import { buildPagination } from "../utils/pagination.js";
import type { MenuItemsQuery } from "../validations/menu.validation.js";

/**
 * A menu item is public when status === "approved".
 * The schema has no separate "active" flag: "inactive" is a status value of its
 * own, so requiring "approved" already excludes pending, rejected and inactive.
 */
const PUBLIC_STATUS = "approved" as const;

/**
 * The items of a BLOCKED vendor are not public either: their orders could not be accepted or
 * rejected (a blocked account is refused by every API), so customers must not be offered them.
 * Nothing is deleted or changed: the items come back the moment the vendor is unblocked.
 * The (normally empty or tiny) list of blocked vendors is read once per request.
 */
const publicFilter = async (): Promise<Filter<MenuItemDoc>> => {
  // find + projection, not distinct(): the Atlas connection uses the strict Stable API, which has no distinct.
  const blockedVendorIds = (
    await usersCollection().find({ role: "vendor", isBlocked: true }).project<{ _id: ObjectId }>({ _id: 1 }).toArray()
  ).map((vendor) => vendor._id);

  return blockedVendorIds.length > 0
    ? { status: PUBLIC_STATUS, vendorId: { $nin: blockedVendorIds } }
    : { status: PUBLIC_STATUS };
};

export const FEATURED_LIMIT = 6;

/**
 * Allow-list of fields that leave the server. vendorId (an internal reference)
 * and status (always "approved" here) are deliberately not included.
 */
const PUBLIC_PROJECTION = {
  itemName: 1,
  category: 1,
  description: 1,
  price: 1,
  location: 1,
  images: 1,
  createdAt: 1,
} as const;

export type PublicMenuItem = Pick<
  MenuItemDoc,
  "_id" | "itemName" | "category" | "description" | "price" | "location" | "images" | "createdAt"
>;

export interface CategorySummary {
  name: string;
  count: number;
}

/** Makes user text safe to put inside a RegExp ("a.b*" matches the literal text only). */
export const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const caseInsensitive = (pattern: string) => ({ $regex: pattern, $options: "i" });

const buildListFilter = async ({ search, category, location }: MenuItemsQuery): Promise<Filter<MenuItemDoc>> => {
  const filter: Filter<MenuItemDoc> = await publicFilter();

  // Exact match, ignoring case: ?category=chicken finds "Chicken" but not "Chicken Wings".
  if (category) filter.category = caseInsensitive(`^${escapeRegex(category)}$`);

  // Partial match, ignoring case: ?location=dhaka finds "Dhaka, Bangladesh".
  if (location) filter.location = caseInsensitive(escapeRegex(location));

  if (search) {
    const pattern = caseInsensitive(escapeRegex(search));

    filter.$or = [
      { itemName: pattern },
      { description: pattern },
      { category: pattern },
      { location: pattern },
    ];
  }

  return filter;
};

/**
 * GET /api/menu-items. One filter object feeds both the page query and the
 * total count, so pagination always matches the filtered result.
 */
export const listPublicMenuItems = async (query: MenuItemsQuery) => {
  const { sortBy, order, page, limit } = query;

  const filter = await buildListFilter(query);
  const direction = order === "asc" ? 1 : -1;

  // _id as a tie-breaker: without it, items with an equal price/createdAt can
  // swap places between two requests and show up on two pages (or none).
  const sort: Sort = { [sortBy]: direction, _id: direction };

  const collection = menuItemsCollection();

  const [items, totalItems] = await Promise.all([
    collection
      .find(filter)
      .project<PublicMenuItem>(PUBLIC_PROJECTION)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    collection.countDocuments(filter),
  ]);

  return { items, pagination: buildPagination(page, limit, totalItems) };
};

/** GET /api/menu-items/:id. Returns null for a missing OR non-public item (the caller answers 404). */
export const findPublicMenuItem = async (id: ObjectId) =>
  menuItemsCollection()
    .find({ _id: id, ...(await publicFilter()) })
    .project<PublicMenuItem>(PUBLIC_PROJECTION)
    .limit(1)
    .next();

/** GET /api/menu-items/featured. No "featured" field exists, so: the newest approved items. */
export const listFeaturedMenuItems = async () =>
  menuItemsCollection()
    .find(await publicFilter())
    .project<PublicMenuItem>(PUBLIC_PROJECTION)
    .sort({ createdAt: -1, _id: -1 })
    .limit(FEATURED_LIMIT)
    .toArray();

/**
 * GET /api/categories. Unique categories of public items with their item count.
 * "Chicken" and "chicken" are the same category (the first spelling in
 * alphabetical order is shown); blank categories are skipped.
 */
export const listPublicCategories = async () =>
  menuItemsCollection()
    .aggregate<CategorySummary>([
      { $match: await publicFilter() },
      { $addFields: { trimmedCategory: { $trim: { input: "$category" } } } },
      { $match: { trimmedCategory: { $ne: "" } } },
      { $sort: { trimmedCategory: 1 } },
      {
        $group: {
          _id: { $toLower: "$trimmedCategory" },
          name: { $first: "$trimmedCategory" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, name: 1, count: 1 } },
    ])
    .toArray();
