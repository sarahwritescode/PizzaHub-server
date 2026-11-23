import { usersCollection, type UserDoc } from "../models/index.js";

/**
 * Allow-list: ONLY these fields are ever read from `users`. Same rule as adminUser.service.ts:
 * no password (it lives in Better Auth's `account` collection), no session or token, no
 * subscription fields and no Stripe ids.
 */
const VENDOR_PROJECTION = { name: 1, email: 1, businessName: 1 } as const;

export type AdminVendorListItem = Pick<UserDoc, "_id" | "name" | "email"> & { businessName: string | null };

type StoredVendor = Pick<UserDoc, "_id" | "name" | "email"> & Partial<Pick<UserDoc, "businessName">>;

/**
 * GET /api/admin/vendors. Every user with role "vendor" (blocked ones included, an admin
 * picking an owner needs the whole list), no pagination, A-Z by name ignoring case
 * (collation strength 2, so "alice" and "Bob" sort as a, b), _id as tie-breaker.
 */
export const listVendors = async (): Promise<AdminVendorListItem[]> => {
  const vendors = await usersCollection()
    .find({ role: "vendor" }, { collation: { locale: "en", strength: 2 } })
    .project<StoredVendor>(VENDOR_PROJECTION)
    .sort({ name: 1, _id: 1 })
    .toArray();

  return vendors.map((vendor) => ({
    _id: vendor._id,
    name: vendor.name,
    email: vendor.email,
    businessName: vendor.businessName ?? null,
  }));
};
