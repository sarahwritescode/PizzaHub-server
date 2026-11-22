import { isDeepStrictEqual } from "node:util";
import type { ClientSession, Filter, ObjectId, TransactionOptions } from "mongodb";

import { client } from "../config/db.js";
import {
  buildMenuItem,
  menuItemsCollection,
  ordersCollection,
  usersCollection,
  type MenuItem,
  type MenuItemDoc,
  type MenuItemStatus,
  type UserDoc,
} from "../models/index.js";
import { HttpError } from "../utils/httpError.js";
import { buildPagination } from "../utils/pagination.js";
import type {
  CreateVendorMenuItemInput,
  UpdateVendorMenuItemInput,
  VendorMenuQuery,
} from "../validations/vendorMenu.validation.js";

// ───────────────────────── business rules ─────────────────────────

/** A Free vendor may hold at most this many active items. Premium: no limit. */
export const FREE_ACTIVE_LIMIT = 3;

/**
 * "Active" = an item that occupies a slot: waiting for approval or live.
 * rejected and inactive items do not count.
 *
 * Why pending counts: if only approved items counted, a Free vendor could queue
 * any number of pending items and the limit would only be reachable at approval
 * time. Counting pending enforces the limit when the item is created, and an
 * admin approving a pending item (pending -> approved) never changes the count.
 */
export const ACTIVE_STATUSES: MenuItemStatus[] = ["pending", "approved"];

const isActiveStatus = (status: MenuItemStatus) => ACTIVE_STATUSES.includes(status);

/**
 * Premium only while the subscription has not expired. Premium without an
 * expiry date is NOT treated as unlimited: the Stripe flow always sets one,
 * so a missing date means something is wrong and the safe fallback is Free.
 */
const hasPremium = (user: Pick<UserDoc, "subscriptionPlan" | "subscriptionExpiresAt">) =>
  user.subscriptionPlan === "premium" &&
  user.subscriptionExpiresAt instanceof Date &&
  user.subscriptionExpiresAt.getTime() > Date.now();

// ───────────────────────── response shape ─────────────────────────

/** Allow-list of fields a vendor gets back. vendorId is not needed: it is the caller's own id. */
const VENDOR_PROJECTION = {
  itemName: 1,
  category: 1,
  description: 1,
  price: 1,
  location: 1,
  images: 1,
  status: 1,
  createdAt: 1,
} as const;

export type VendorMenuItem = Pick<
  MenuItemDoc,
  | "_id"
  | "itemName"
  | "category"
  | "description"
  | "price"
  | "location"
  | "images"
  | "status"
  | "createdAt"
>;

const toVendorItem = (item: MenuItemDoc): VendorMenuItem => ({
  _id: item._id,
  itemName: item.itemName,
  category: item.category,
  description: item.description,
  price: item.price,
  location: item.location,
  images: item.images,
  status: item.status,
  createdAt: item.createdAt,
});

export const itemNotFound = () => new HttpError(404, "Menu item not found", "MENU_ITEM_NOT_FOUND");

// ───────────────────── per-vendor lock + limit check ─────────────────────

const TRANSACTION_OPTIONS: TransactionOptions = {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
};

interface VendorContext {
  session: ClientSession;
  premium: boolean;
}

/**
 * Runs `work` as one vendor, one at a time.
 *
 * "Count the active items, then insert" is a race: two requests can both count 2
 * and both insert, ending at 4. A transaction alone does not stop that (both
 * would write different documents, so nothing conflicts). So every transaction
 * first writes the vendor's own user document. Two transactions of the same
 * vendor then conflict on that document, MongoDB aborts one with a transient
 * error, the driver retries it, and the retry counts again and sees the
 * committed result. Different vendors never touch each other's document.
 * The write only bumps `updatedAt`.
 *
 * The subscription is read inside the same transaction, from the database
 * (never from the request), so a plan that expires mid-request is honoured.
 */
const runAsVendor = async <T>(
  vendorId: ObjectId,
  work: (context: VendorContext) => Promise<T>
): Promise<T> => {
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      const vendor = await usersCollection().findOneAndUpdate(
        { _id: vendorId },
        { $currentDate: { updatedAt: true } },
        {
          session,
          returnDocument: "after",
          projection: { subscriptionPlan: 1, subscriptionExpiresAt: 1 },
        }
      );

      if (!vendor) {
        throw new HttpError(401, "Account not found", "INVALID_TOKEN");
      }

      return work({ session, premium: hasPremium(vendor) });
    }, TRANSACTION_OPTIONS);
  } finally {
    await session.endSession();
  }
};

/** Call before an item newly becomes active (created, resubmitted, re-activated). */
const assertActiveSlotAvailable = async ({ session, premium }: VendorContext, vendorId: ObjectId) => {
  if (premium) return;

  const used = await menuItemsCollection().countDocuments(
    { vendorId, status: { $in: ACTIVE_STATUSES } },
    { session }
  );

  if (used >= FREE_ACTIVE_LIMIT) {
    throw new HttpError(
      403,
      `The Free plan allows at most ${FREE_ACTIVE_LIMIT} active menu items. ` +
        "Delete or switch off another item, or upgrade to Premium.",
      "FREE_PLAN_LIMIT_REACHED"
    );
  }
};

const findOwnItem = async (vendorId: ObjectId, itemId: ObjectId, session: ClientSession) => {
  // Filtering by vendorId IS the ownership check: someone else's item looks
  // exactly like a missing one, so ids of other vendors' items are not revealed.
  const item = await menuItemsCollection().findOne({ _id: itemId, vendorId }, { session });

  if (!item) throw itemNotFound();

  return item;
};

// ───────────────────────── operations ─────────────────────────

/** GET /api/vendor/menu-items: the vendor's own items, any status. */
export const listVendorMenuItems = async (vendorId: ObjectId, query: VendorMenuQuery) => {
  const { status, page, limit } = query;
  const filter: Filter<MenuItemDoc> = { vendorId, ...(status ? { status } : {}) };

  const collection = menuItemsCollection();

  const [items, totalItems] = await Promise.all([
    collection
      .find(filter)
      .project<VendorMenuItem>(VENDOR_PROJECTION)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    collection.countDocuments(filter),
  ]);

  return { items, pagination: buildPagination(page, limit, totalItems) };
};

/** POST /api/vendor/menu-items: always created as "pending", owned by the caller. */
export const createVendorMenuItem = (vendorId: ObjectId, input: CreateVendorMenuItemInput) =>
  runAsVendor(vendorId, async (context) => {
    await assertActiveSlotAvailable(context, vendorId);

    // vendorId comes from the verified login, status and createdAt from the
    // model defaults ("pending", now): the client controls none of them.
    const item = buildMenuItem({ ...input, vendorId });

    const { insertedId } = await menuItemsCollection().insertOne(item as MenuItemDoc, {
      session: context.session,
    });

    return toVendorItem({ ...item, _id: insertedId });
  });

const CONTENT_FIELDS = [
  "itemName",
  "category",
  "description",
  "price",
  "location",
  "images",
] as const satisfies readonly (keyof MenuItem)[];

/**
 * PATCH /api/vendor/menu-items/:id
 *
 * Any real change of content sends the item back to "pending", whatever it was
 * before. That is what prevents an approval bypass: an approved (or switched
 * off) item cannot be edited and stay public/re-activatable with unreviewed
 * content, and a rejected item is resubmitted by editing it.
 * If the item was not occupying a slot (rejected / inactive) it needs a free one.
 * Sending the values it already has changes nothing, including its status.
 */
export const updateVendorMenuItem = (
  vendorId: ObjectId,
  itemId: ObjectId,
  input: UpdateVendorMenuItemInput
) =>
  runAsVendor(vendorId, async (context) => {
    const item = await findOwnItem(vendorId, itemId, context.session);

    // Only fields from this allow-list are ever written.
    const changes: Partial<Pick<MenuItem, (typeof CONTENT_FIELDS)[number]>> = {};

    for (const field of CONTENT_FIELDS) {
      const next = input[field];

      if (next !== undefined && !isDeepStrictEqual(next, item[field])) {
        Object.assign(changes, { [field]: next });
      }
    }

    if (Object.keys(changes).length === 0) {
      return { item: toVendorItem(item), changed: false, previousStatus: item.status };
    }

    if (!isActiveStatus(item.status)) {
      await assertActiveSlotAvailable(context, vendorId);
    }

    await menuItemsCollection().updateOne(
      { _id: item._id, vendorId },
      { $set: { ...changes, status: "pending" } },
      { session: context.session }
    );

    return {
      item: toVendorItem({ ...item, ...changes, status: "pending" }),
      changed: true,
      previousStatus: item.status,
    };
  });

/**
 * PATCH /api/vendor/menu-items/:id/availability
 *
 * There is no isActive field, availability is the status:
 *   isActive: false   approved -> inactive   (hidden from the public menu)
 *   isActive: true    inactive -> approved   (needs a free slot on the Free plan)
 * "inactive" only ever comes from this endpoint (or an admin) for an item that
 * was approved, and editing an inactive item sends it to "pending" (see above),
 * so re-activating can never publish content that was not approved.
 * A vendor cannot approve anything: pending and rejected items are refused.
 */
export const setVendorMenuItemAvailability = (
  vendorId: ObjectId,
  itemId: ObjectId,
  isActive: boolean
) =>
  runAsVendor(vendorId, async (context) => {
    const item = await findOwnItem(vendorId, itemId, context.session);

    const target: MenuItemStatus = isActive ? "approved" : "inactive";
    const source: MenuItemStatus = isActive ? "inactive" : "approved";

    if (item.status === target) {
      return { item: toVendorItem(item), changed: false }; // already there
    }

    if (item.status !== source) {
      throw new HttpError(
        409,
        isActive
          ? `A ${item.status} item cannot be activated by the vendor. Only an admin approves items.`
          : `Only an approved item can be switched off (this one is ${item.status}).`,
        "INVALID_STATUS_TRANSITION"
      );
    }

    if (isActive) {
      await assertActiveSlotAvailable(context, vendorId);
    }

    await menuItemsCollection().updateOne(
      { _id: item._id, vendorId, status: source },
      { $set: { status: target } },
      { session: context.session }
    );

    return { item: toVendorItem({ ...item, status: target }), changed: true };
  });

/**
 * Orders point at the item by id. Deleting it while a customer is waiting for
 * it would leave an order for something that no longer exists. Shared with the
 * admin delete (adminMenu.service.ts) so both apply the same rule.
 */
export const assertNoOpenOrders = async (itemId: ObjectId) => {
  const openOrders = await ordersCollection().countDocuments(
    { itemId, status: { $in: ["pending", "accepted"] } },
    { limit: 1 }
  );

  if (openOrders > 0) {
    throw new HttpError(
      409,
      "This item has open orders. Switch it off instead, or delete it after the orders are finished.",
      "ITEM_HAS_OPEN_ORDERS"
    );
  }
};

/** DELETE /api/vendor/menu-items/:id */
export const deleteVendorMenuItem = async (vendorId: ObjectId, itemId: ObjectId) => {
  const item = await menuItemsCollection().findOne(
    { _id: itemId, vendorId },
    { projection: { _id: 1 } }
  );

  if (!item) throw itemNotFound();

  await assertNoOpenOrders(itemId);

  const { deletedCount } = await menuItemsCollection().deleteOne({ _id: itemId, vendorId });

  if (deletedCount === 0) throw itemNotFound(); // removed by a parallel request
};
