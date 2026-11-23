import type { Collection, Document } from "mongodb";

import {
  MENU_ITEM_STATUSES,
  ORDER_STATUSES,
  TRANSACTION_STATUSES,
  menuItemsCollection,
  ordersCollection,
  transactionsCollection,
  usersCollection,
  type TransactionDoc,
} from "../models/index.js";
import { withTransactionVendors } from "./adminTransaction.service.js";
import { listUsers } from "./adminUser.service.js";

/** How many rows each "recent" list shows. */
const RECENT_LIMIT = 5;

/** { pending: 3, ... } with EVERY known status present (0 when there is none), plus the total. */
const countsBy = async <T extends Document, K extends string>(
  collection: Collection<T>,
  field: string,
  keys: readonly K[]
): Promise<Record<K, number> & { total: number }> => {
  const groups = await collection
    .aggregate<{ _id: unknown; count: number }>([{ $group: { _id: `$${field}`, count: { $sum: 1 } } }])
    .toArray();

  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  let total = 0;

  for (const { _id, count } of groups) {
    total += count; // unknown values (should not exist) still count towards the total
    if (typeof _id === "string" && (keys as readonly string[]).includes(_id)) counts[_id as K] = count;
  }

  return { ...counts, total };
};

const userStats = async () => {
  const [facets] = await usersCollection()
    .aggregate<{
      byRole: { _id: unknown; count: number }[];
      blocked: { n: number }[];
      premium: { n: number }[];
    }>([
      {
        $facet: {
          byRole: [{ $group: { _id: "$role", count: { $sum: 1 } } }],
          blocked: [{ $match: { isBlocked: true } }, { $count: "n" }],
          // The same rule as the menu and subscription APIs (hasPremium): premium AND not yet expired.
          premium: [
            { $match: { role: "vendor", subscriptionPlan: "premium", subscriptionExpiresAt: { $gt: new Date() } } },
            { $count: "n" },
          ],
        },
      },
    ])
    .toArray();

  const roleCount = (role: string) => facets?.byRole.find((group) => group._id === role)?.count ?? 0;

  return {
    total: (facets?.byRole ?? []).reduce((sum, group) => sum + group.count, 0),
    customers: roleCount("customer"),
    vendors: roleCount("vendor"),
    admins: roleCount("admin"),
    blocked: facets?.blocked[0]?.n ?? 0,
    activePremiumVendors: facets?.premium[0]?.n ?? 0,
  };
};

/**
 * GET /api/admin/dashboard. Every number is counted in the database right now (aggregation
 * pipelines, no cached or hard-coded values). The four collections are read independently, so
 * they are fetched in parallel.
 */
export const getDashboard = async () => {
  const [users, menuItems, orders, transactions, recentUsers, recentOrders, recentTransactions] = await Promise.all([
    userStats(),
    countsBy(menuItemsCollection(), "status", MENU_ITEM_STATUSES),
    countsBy(ordersCollection(), "status", ORDER_STATUSES),
    countsBy(transactionsCollection(), "status", TRANSACTION_STATUSES),

    listUsers({ page: 1, limit: RECENT_LIMIT }).then((result) => result.items),

    ordersCollection()
      .find({})
      .project({ itemId: 1, vendorId: 1, customerId: 1, status: 1, deliveryDate: 1, createdAt: 1 })
      .sort({ createdAt: -1, _id: -1 })
      .limit(RECENT_LIMIT)
      .toArray(),

    transactionsCollection()
      .find({})
      .sort({ createdAt: -1, _id: -1 })
      .limit(RECENT_LIMIT)
      .toArray()
      .then((rows) => withTransactionVendors(rows as TransactionDoc[])),
  ]);

  return {
    users: {
      total: users.total,
      customers: users.customers,
      vendors: users.vendors,
      admins: users.admins,
      blocked: users.blocked,
    },
    menuItems: {
      total: menuItems.total,
      pending: menuItems.pending,
      approved: menuItems.approved,
      rejected: menuItems.rejected,
      inactive: menuItems.inactive,
    },
    orders: {
      total: orders.total,
      pending: orders.pending,
      accepted: orders.accepted,
      rejected: orders.rejected,
      cancelled: orders.cancelled,
    },
    transactions: {
      total: transactions.total,
      success: transactions.success,
      pending: transactions.pending,
      failed: transactions.failed,
      cancelled: transactions.cancelled,
      expired: transactions.expired,
    },
    subscriptions: { activePremiumVendors: users.activePremiumVendors },
    recent: { users: recentUsers, orders: recentOrders, transactions: recentTransactions },
  };
};
