import type { ObjectId } from "mongodb";

import {
  ACTIVE_ORDER_STATUSES,
  buildOrder,
  menuItemsCollection,
  ordersCollection,
  usersCollection,
  type MenuItemDoc,
  type OrderDoc,
  type UserDoc,
} from "../models/index.js";
import { HttpError } from "../utils/httpError.js";
import { buildPagination } from "../utils/pagination.js";
import type { CreateOrderInput, MyOrdersQuery } from "../validations/order.validation.js";

const DUPLICATE_KEY = 11000;

const orderNotFound = () => new HttpError(404, "Order not found", "ORDER_NOT_FOUND");

// ───────────────────────── response shape ─────────────────────────

/** The menu item as a customer may see it on an order. No vendorId, no status. */
const ITEM_PROJECTION = { itemName: 1, category: 1, price: 1, location: 1, images: 1 } as const;
export type OrderItemInfo = Pick<MenuItemDoc, "_id" | "itemName" | "category" | "price" | "location" | "images">;

/** The vendor as a customer may see them: a display name only. No email, role, plan or flags. */
const VENDOR_PROJECTION = { name: 1, businessName: 1 } as const;
export type OrderVendorInfo = Pick<UserDoc, "_id" | "name" | "businessName">;

/**
 * An order as the customer who placed it gets it. customerId is left out (it is the caller),
 * vendorId is replaced by `vendor`. `item` / `vendor` are null if that document no longer
 * exists (an item can be deleted after its orders are finished): the order stays readable.
 */
export interface CustomerOrder {
  _id: ObjectId;
  itemId: ObjectId;
  deliveryDate: Date;
  deliveryAddress: string;
  message?: string;
  status: OrderDoc["status"];
  createdAt: Date;
  item: OrderItemInfo | null;
  vendor: OrderVendorInfo | null;
}

/** Two queries for the whole page (items, vendors) instead of two per order. */
const toCustomerOrders = async (orders: OrderDoc[]): Promise<CustomerOrder[]> => {
  const unique = (ids: ObjectId[]) => [...new Map(ids.map((id) => [id.toHexString(), id])).values()];
  const itemIds = unique(orders.map((order) => order.itemId));
  const vendorIds = unique(orders.map((order) => order.vendorId));

  const [items, vendors] = await Promise.all([
    itemIds.length
      ? menuItemsCollection().find({ _id: { $in: itemIds } }).project<OrderItemInfo>(ITEM_PROJECTION).toArray()
      : [],
    vendorIds.length
      ? usersCollection().find({ _id: { $in: vendorIds } }).project<OrderVendorInfo>(VENDOR_PROJECTION).toArray()
      : [],
  ]);

  const itemById = new Map(items.map((item) => [item._id.toHexString(), item]));
  const vendorById = new Map(vendors.map((vendor) => [vendor._id.toHexString(), vendor]));

  return orders.map((order) => ({
    _id: order._id,
    itemId: order.itemId,
    deliveryDate: order.deliveryDate,
    deliveryAddress: order.deliveryAddress,
    ...(order.message ? { message: order.message } : {}),
    status: order.status,
    createdAt: order.createdAt,
    item: itemById.get(order.itemId.toHexString()) ?? null,
    vendor: vendorById.get(order.vendorId.toHexString()) ?? null,
  }));
};

// ───────────────────────── operations ─────────────────────────

/**
 * POST /api/orders
 *
 * customerId is the verified caller, vendorId is read from the menu item, status is "pending":
 * the client controls none of them. Only an "approved" item can be ordered ("inactive" is a
 * status of its own, so approved already means "active").
 *
 * Duplicates: the unique partial index orders_active_customer_item_date_uidx is what makes
 * "one active order per customer, item and day" safe against parallel requests (the loser gets
 * E11000). The look-up before the insert only gives the normal case the same friendly answer.
 */
export const createOrder = async (customerId: ObjectId, input: CreateOrderInput) => {
  const item = await menuItemsCollection().findOne({ _id: input.itemId });

  if (!item) {
    throw new HttpError(404, "Menu item not found", "MENU_ITEM_NOT_FOUND");
  }

  // The same answer for pending, rejected and inactive: a customer is not told which one it is.
  if (item.status !== "approved") {
    throw new HttpError(409, "This menu item is not available for ordering.", "MENU_ITEM_UNAVAILABLE");
  }

  if (item.vendorId.equals(customerId)) {
    throw new HttpError(403, "You cannot order your own menu item.", "CANNOT_ORDER_OWN_ITEM");
  }

  const duplicate = () =>
    new HttpError(
      409,
      "You already have an active order for this item on that delivery date.",
      "DUPLICATE_ORDER"
    );

  const existing = await ordersCollection().findOne(
    {
      itemId: item._id,
      customerId,
      deliveryDate: input.deliveryDate,
      status: { $in: ACTIVE_ORDER_STATUSES },
    },
    { projection: { _id: 1 } }
  );

  if (existing) throw duplicate();

  const order = buildOrder({
    itemId: item._id,
    vendorId: item.vendorId,
    customerId,
    deliveryDate: input.deliveryDate,
    deliveryAddress: input.deliveryAddress,
    ...(input.message ? { message: input.message } : {}),
  });

  let insertedId: ObjectId;

  try {
    ({ insertedId } = await ordersCollection().insertOne(order as OrderDoc));
  } catch (error) {
    if ((error as { code?: number }).code === DUPLICATE_KEY) throw duplicate();
    throw error;
  }

  const [created] = await toCustomerOrders([{ ...order, _id: insertedId }]);
  return created!;
};

/** GET /api/orders/my-orders: only the caller's orders, newest first. */
export const listMyOrders = async (customerId: ObjectId, { page, limit }: MyOrdersQuery) => {
  const filter = { customerId };
  const collection = ordersCollection();

  const [orders, totalItems] = await Promise.all([
    collection
      .find(filter)
      // _id as tie-breaker: equal createdAt values must not swap places between pages.
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    collection.countDocuments(filter),
  ]);

  return { items: await toCustomerOrders(orders), pagination: buildPagination(page, limit, totalItems) };
};

/**
 * GET /api/orders/:id. Filtering by customerId IS the ownership check: someone else's order
 * looks exactly like a missing one (404), so order ids of other customers are not revealed.
 */
export const getMyOrder = async (customerId: ObjectId, orderId: ObjectId) => {
  const order = await ordersCollection().findOne({ _id: orderId, customerId });
  if (!order) throw orderNotFound();

  const [result] = await toCustomerOrders([order]);
  return result!;
};

/**
 * PATCH /api/orders/:id/cancel. Only the caller's own pending order.
 * The write itself only matches while the order is still pending, so a cancel and a vendor
 * accept happening at the same moment cannot both win, and cancelling twice at once cancels once.
 */
export const cancelMyOrder = async (customerId: ObjectId, orderId: ObjectId) => {
  const collection = ordersCollection();

  const { matchedCount } = await collection.updateOne(
    { _id: orderId, customerId, status: "pending" },
    { $set: { status: "cancelled" } }
  );

  // Either it is not the caller's / does not exist, or it was not pending. Look again to tell which.
  const order = await collection.findOne({ _id: orderId, customerId });
  if (!order) throw orderNotFound();

  if (matchedCount === 0) {
    throw new HttpError(
      409,
      order.status === "cancelled"
        ? "This order is already cancelled."
        : `Only a pending order can be cancelled (this one is ${order.status}).`,
      "INVALID_STATUS_TRANSITION"
    );
  }

  const [result] = await toCustomerOrders([order]);
  return result!;
};
