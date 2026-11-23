import type { Filter, ObjectId, Sort } from "mongodb";

import { menuItemsCollection, usersCollection, type MenuItemDoc, type UserDoc } from "../models/index.js";
import { buildPagination } from "../utils/pagination.js";
import type { MenuItemsQuery } from "../validations/menu.validation.js";
import { hasPremium } from "./vendorMenu.service.js";

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
 * Allow-list of fields read from the database. vendorId is read only to look the vendor up and
 * is removed again before anything leaves the server; status (always "approved" here) is not read.
 */
const PUBLIC_PROJECTION = {
  itemName: 1,
  category: 1,
  description: 1,
  price: 1,
  location: 1,
  images: 1,
  createdAt: 1,
  vendorId: 1,
} as const;

type StoredPublicItem = Pick<
  MenuItemDoc,
  "_id" | "itemName" | "category" | "description" | "price" | "location" | "images" | "createdAt" | "vendorId"
>;

/**
 * What a customer may know about the vendor: a name, the business name and the Premium badge.
 * No id, no email, no plan dates and no Stripe or subscription data.
 */
export interface PublicVendor {
  name: string;
  businessName: string | null;
  /** The EFFECTIVE Premium state: false for a Free vendor and for a Premium whose paid period has run out. */
  isPremium: boolean;
}

export type PublicMenuItem = Pick<
  MenuItemDoc,
  "_id" | "itemName" | "category" | "description" | "price" | "location" | "images" | "createdAt"
> & {
  /** null only when the vendor account no longer exists (the item is still listed). */
  vendor: PublicVendor | null;
};

/** Allow-list read from `users` (never the email, the role or any Stripe field). */
const VENDOR_PROJECTION = { name: 1, businessName: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1 } as const;

type StoredVendor = Pick<UserDoc, "_id" | "name"> &
  Partial<Pick<UserDoc, "businessName" | "subscriptionPlan" | "subscriptionExpiresAt">>;

/**
 * Adds `vendor` to every item and drops vendorId. One extra query for all vendors of the page
 * (not one per item), the same approach as the admin menu list.
 */
const withPublicVendors = async (items: StoredPublicItem[]): Promise<PublicMenuItem[]> => {
  const vendorIds = [...new Map(items.map((item) => [item.vendorId.toHexString(), item.vendorId])).values()];

  const vendors =
    vendorIds.length === 0
      ? []
      : await usersCollection()
          .find({ _id: { $in: vendorIds } })
          .project<StoredVendor>(VENDOR_PROJECTION)
          .toArray();

  const byId = new Map(vendors.map((vendor) => [vendor._id.toHexString(), vendor]));

  return items.map(({ vendorId, ...item }) => {
    const vendor = byId.get(vendorId.toHexString());

    return {
      ...item,
      vendor: vendor
        ? {
            name: vendor.name,
            businessName: vendor.businessName ?? null,
            isPremium: hasPremium({
              subscriptionPlan: vendor.subscriptionPlan ?? "free",
              subscriptionExpiresAt: vendor.subscriptionExpiresAt,
            }),
          }
        : null,
    };
  });
};

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
      .project<StoredPublicItem>(PUBLIC_PROJECTION)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    collection.countDocuments(filter),
  ]);

  return { items: await withPublicVendors(items), pagination: buildPagination(page, limit, totalItems) };
};

/** GET /api/menu-items/:id. Returns null for a missing OR non-public item (the caller answers 404). */
export const findPublicMenuItem = async (id: ObjectId): Promise<PublicMenuItem | null> => {
  const item = await menuItemsCollection()
    .find({ _id: id, ...(await publicFilter()) })
    .project<StoredPublicItem>(PUBLIC_PROJECTION)
    .limit(1)
    .next();

  return item ? (await withPublicVendors([item]))[0]! : null;
};

/**
 * GET /api/menu-items/featured. No "featured" field exists, so: items of vendors with an ACTIVE
 * Premium plan first (newest first), then the newest approved items of everyone else, 6 in total.
 * A Premium whose paid period has run out does not count (the same rule as hasPremium).
 * Only this endpoint puts Premium first; the normal list keeps the sort the caller asked for.
 */
export const listFeaturedMenuItems = async (): Promise<PublicMenuItem[]> => {
  const visible = await publicFilter();

  // find + projection, not distinct(): the Atlas connection uses the strict Stable API, which has no distinct.
  const premiumVendorIds = (
    await usersCollection()
      .find({ role: "vendor", subscriptionPlan: "premium", subscriptionExpiresAt: { $gt: new Date() } })
      .project<{ _id: ObjectId }>({ _id: 1 })
      .toArray()
  ).map((vendor) => vendor._id);

  const newestFirst = { createdAt: -1, _id: -1 } as const;

  const premiumItems =
    premiumVendorIds.length === 0
      ? []
      : await menuItemsCollection()
          .find({ $and: [visible, { vendorId: { $in: premiumVendorIds } }] })
          .project<StoredPublicItem>(PUBLIC_PROJECTION)
          .sort(newestFirst)
          .limit(FEATURED_LIMIT)
          .toArray();

  const otherItems =
    premiumItems.length >= FEATURED_LIMIT
      ? []
      : await menuItemsCollection()
          .find(
            premiumVendorIds.length === 0
              ? visible
              : { $and: [visible, { vendorId: { $nin: premiumVendorIds } }] }
          )
          .project<StoredPublicItem>(PUBLIC_PROJECTION)
          .sort(newestFirst)
          .limit(FEATURED_LIMIT - premiumItems.length)
          .toArray();

  return withPublicVendors([...premiumItems, ...otherItems]);
};

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
