import type { Filter } from "mongodb";

import { transactionsCollection, usersCollection, type TransactionDoc, type UserDoc } from "../models/index.js";
import { buildPagination } from "../utils/pagination.js";
import type { AdminTransactionsQuery } from "../validations/admin.validation.js";

// Read-only: this file has no write of any kind, and the admin router has no route that could call one.

/** The vendor fields an admin sees next to a transaction: no role, plan, flags or Stripe ids. */
const VENDOR_PROJECTION = { name: 1, email: 1, businessName: 1 } as const;

export type TransactionVendor = Pick<UserDoc, "_id" | "name" | "email" | "businessName">;

/**
 * The whole stored transaction: vendorId, plan, amount, currency, status, createdAt and the Stripe
 * session / subscription ids (references an admin needs to find the payment in the Stripe
 * Dashboard; they are not secrets and cannot be used to charge or read card data), plus the
 * vendor. A transaction holds no card details, keys or customer data.
 */
export type AdminTransaction = TransactionDoc & { vendor: TransactionVendor | null };

/** One extra query for all vendors of a page. `vendor` is null if the account no longer exists. */
export const withTransactionVendors = async (transactions: TransactionDoc[]): Promise<AdminTransaction[]> => {
  const vendorIds = [...new Map(transactions.map((t) => [t.vendorId.toHexString(), t.vendorId])).values()];

  const vendors =
    vendorIds.length === 0
      ? []
      : await usersCollection()
          .find({ _id: { $in: vendorIds } })
          .project<TransactionVendor>(VENDOR_PROJECTION)
          .toArray();

  const byId = new Map(vendors.map((vendor) => [vendor._id.toHexString(), vendor]));

  return transactions.map((t) => ({ ...t, vendor: byId.get(t.vendorId.toHexString()) ?? null }));
};

/** GET /api/admin/transactions: newest first. */
export const listTransactions = async ({ status, vendorId, page, limit }: AdminTransactionsQuery) => {
  const filter: Filter<TransactionDoc> = {};

  if (status) filter.status = status;
  if (vendorId) filter.vendorId = vendorId;

  const collection = transactionsCollection();

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

  return {
    items: await withTransactionVendors(items as TransactionDoc[]),
    pagination: buildPagination(page, limit, totalItems),
  };
};
