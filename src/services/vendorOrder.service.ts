import type { Filter, ObjectId } from "mongodb";

import { ordersCollection, usersCollection, type OrderDoc, type UserDoc } from "../models/index.js";
import { buildPagination } from "../utils/pagination.js";
import type { VendorOrdersQuery } from "../validations/order.validation.js";
import { lookupOrderItems, moveOrderFromPending, type CustomerOrder, type OrderItemInfo } from "./order.service.js";

// ───────────────────────── response shape ─────────────────────────

/**
 * The customer as a vendor may see them: id and display name, enough to know who to deliver to.
 * No email, role, plan, flags or tokens. The delivery address is on the order itself.
 */
const CUSTOMER_PROJECTION = { name: 1 } as const;
export type OrderCustomerInfo = Pick<UserDoc, "_id" | "name">;

/**
 * An order as the vendor it belongs to gets it. The same fields, names and types as the order a
 * customer gets (CustomerOrder), except that `vendor` (the caller) is replaced by `customer`.
 * `item` / `customer` are null if that document no longer exists; the order stays readable.
 */
export type VendorOrder = Omit<CustomerOrder, "vendor"> & { customer: OrderCustomerInfo | null };

const toVendorOrders = async (orders: OrderDoc[]): Promise<VendorOrder[]> => {
  const customerIds = [...new Map(orders.map((order) => [order.customerId.toHexString(), order.customerId])).values()];

  const [itemById, customers] = await Promise.all([
    lookupOrderItems(orders),
    customerIds.length
      ? usersCollection().find({ _id: { $in: customerIds } }).project<OrderCustomerInfo>(CUSTOMER_PROJECTION).toArray()
      : [],
  ]);

  const customerById = new Map(customers.map((customer) => [customer._id.toHexString(), customer]));

  return orders.map((order) => ({
    _id: order._id,
    itemId: order.itemId,
    deliveryDate: order.deliveryDate,
    deliveryAddress: order.deliveryAddress,
    ...(order.message ? { message: order.message } : {}),
    status: order.status,
    createdAt: order.createdAt,
    item: (itemById.get(order.itemId.toHexString()) ?? null) as OrderItemInfo | null,
    customer: customerById.get(order.customerId.toHexString()) ?? null,
  }));
};

// ───────────────────────── operations ─────────────────────────

/**
 * GET /api/vendor/orders: orders for the caller's own menu items, newest first.
 * order.vendorId was copied from the menu item when the order was placed (the client never
 * sends it), so filtering by it is the ownership check: other vendors' orders never match.
 */
export const listVendorOrders = async (vendorId: ObjectId, { status, page, limit }: VendorOrdersQuery) => {
  const filter: Filter<OrderDoc> = { vendorId, ...(status ? { status } : {}) };
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

  return { items: await toVendorOrders(orders), pagination: buildPagination(page, limit, totalItems) };
};

/**
 * PATCH /api/vendor/orders/:id/accept and /reject. Only the caller's own pending order.
 * The ownership check, the "only pending" rule and the protection against a customer cancel or
 * another accept/reject at the same moment are in moveOrderFromPending, shared with the
 * customer's cancel: at most one of them can succeed.
 */
export const decideVendorOrder = async (vendorId: ObjectId, orderId: ObjectId, decision: "accepted" | "rejected") => {
  const order = await moveOrderFromPending({ vendorId }, orderId, decision);

  const [result] = await toVendorOrders([order]);
  return result!;
};
