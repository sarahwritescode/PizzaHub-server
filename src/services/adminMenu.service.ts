import { ObjectId, type Filter } from "mongodb";

import {
  menuItemsCollection,
  usersCollection,
  type MenuItemDoc,
  type MenuItemStatus,
  type UserDoc,
} from "../models/index.js";
import { HttpError } from "../utils/httpError.js";
import { buildPagination } from "../utils/pagination.js";
import type { AdminMenuQuery } from "../validations/adminMenu.validation.js";
import { escapeRegex } from "./menu.service.js";
import { assertNoOpenOrders, itemNotFound } from "./vendorMenu.service.js";

// ───────────────────────── response shape ─────────────────────────

/** The only vendor fields an admin gets: enough to know who owns the item. No role, plan, flags or tokens. */
const VENDOR_PROJECTION = { name: 1, email: 1, businessName: 1 } as const;

export type AdminVendorInfo = Pick<UserDoc, "_id" | "name" | "email" | "businessName">;

/** The whole menu item (admins see every field, including vendorId and status) plus its owner. */
export type AdminMenuItem = MenuItemDoc & { vendor: AdminVendorInfo | null };

/**
 * One extra query for all vendors of a page instead of one per item. `vendor`
 * is null when the owner's account no longer exists, the item is still listed.
 */
const withVendors = async (items: MenuItemDoc[]): Promise<AdminMenuItem[]> => {
  const vendorIds = [...new Map(items.map((item) => [item.vendorId.toHexString(), item.vendorId])).values()];

  const vendors =
    vendorIds.length === 0
      ? []
      : await usersCollection()
          .find({ _id: { $in: vendorIds } })
          .project<AdminVendorInfo>(VENDOR_PROJECTION)
          .toArray();

  const byId = new Map(vendors.map((vendor) => [vendor._id.toHexString(), vendor]));

  return items.map((item) => ({ ...item, vendor: byId.get(item.vendorId.toHexString()) ?? null }));
};

// ───────────────────────── list ─────────────────────────

const buildListFilter = ({ status, category, search }: AdminMenuQuery): Filter<MenuItemDoc> => {
  const filter: Filter<MenuItemDoc> = {};

  if (status) filter.status = status;

  // Exact match ignoring case, the same rule as the public list: ?category=pizza finds "Pizza", not "Pizza Rolls".
  if (category) filter.category = { $regex: `^${escapeRegex(category)}$`, $options: "i" };

  // Partial match ignoring case on the item name only.
  if (search) filter.itemName = { $regex: escapeRegex(search), $options: "i" };

  return filter;
};

/** GET /api/admin/menu-items: every vendor's items, any status, newest first. */
export const listAdminMenuItems = async (query: AdminMenuQuery) => {
  const { page, limit } = query;
  const filter = buildListFilter(query);
  const collection = menuItemsCollection();

  const [items, totalItems] = await Promise.all([
    collection
      .find(filter)
      // _id as tie-breaker: equal createdAt values must not swap places between pages.
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    collection.countDocuments(filter),
  ]);

  return { items: await withVendors(items), pagination: buildPagination(page, limit, totalItems) };
};

// ───────────────────────── status changes ─────────────────────────

/**
 * Every status change an admin may make. Anything not listed is refused (409).
 * These are the rules already in the vendor API (docs/VENDOR_MENU_TESTING.md):
 *
 *   pending  -> approved   approve
 *   pending  -> rejected   reject
 *   approved -> inactive   switch off (an approved item that should leave the public menu)
 *
 * Deliberately NOT allowed:
 *   rejected -> anything   a rejected item comes back only when its vendor edits it (-> pending)
 *   inactive -> approved   the vendor activates it, and the Free-plan slot limit applies there;
 *                          an admin shortcut would bypass that limit
 *   anything -> pending    only a vendor edit sends an item back to pending
 */
const ALLOWED_TRANSITIONS: Record<MenuItemStatus, readonly MenuItemStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["inactive"],
  rejected: [],
  inactive: [],
};

const REQUIRED_STATUS: Partial<Record<MenuItemStatus, string>> = {
  approved: "Only a pending item can be approved",
  rejected: "Only a pending item can be rejected",
  inactive: "Only an approved item can be set to inactive",
  pending: "An admin cannot move an item back to pending (a vendor resubmits an item by editing it)",
};

const assertTransition = (from: MenuItemStatus, to: MenuItemStatus) => {
  if (from === to) {
    throw new HttpError(409, `This menu item is already ${to}.`, "INVALID_STATUS_TRANSITION");
  }

  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new HttpError(409, `${REQUIRED_STATUS[to]} (this one is ${from}).`, "INVALID_STATUS_TRANSITION");
  }
};

/**
 * Approve, reject and PATCH /status all end up here, so the rules cannot differ
 * between the endpoints. The write only matches while the item still has the
 * status that was checked: two admins acting at once cannot both succeed.
 * Approving never changes a vendor's Free-plan count (pending and approved both count).
 */
export const changeMenuItemStatus = async (itemId: ObjectId, target: MenuItemStatus): Promise<AdminMenuItem> => {
  const collection = menuItemsCollection();

  const item = await collection.findOne({ _id: itemId });
  if (!item) throw itemNotFound();

  assertTransition(item.status, target);

  const { matchedCount } = await collection.updateOne(
    { _id: itemId, status: item.status },
    { $set: { status: target } }
  );

  if (matchedCount === 0) {
    // Changed or deleted between the read and the write.
    const latest = await collection.findOne({ _id: itemId });
    if (!latest) throw itemNotFound();

    assertTransition(latest.status, target);
    throw new HttpError(409, "The menu item was changed by someone else. Please try again.", "CONCURRENT_UPDATE");
  }

  const [updated] = await withVendors([{ ...item, status: target }]);
  return updated!;
};

// ───────────────────────── delete ─────────────────────────

/**
 * DELETE /api/admin/menu-items/:id. Any vendor's item, any status.
 * Same safety rule as the vendor delete: an item with open orders is refused.
 * Only the menu item document is removed: images stay where they are (ImgBB
 * links are not stored with a delete handle, and other places may still show them).
 */
export const deleteAdminMenuItem = async (itemId: ObjectId) => {
  const item = await menuItemsCollection().findOne({ _id: itemId }, { projection: { _id: 1 } });
  if (!item) throw itemNotFound();

  await assertNoOpenOrders(itemId);

  const { deletedCount } = await menuItemsCollection().deleteOne({ _id: itemId });
  if (deletedCount === 0) throw itemNotFound(); // removed by a parallel request
};
