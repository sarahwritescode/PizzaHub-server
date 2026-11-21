import type { ObjectId } from "mongodb";

import { COLLECTIONS, type CollectionDefinition } from "./common.js";

/**
 * `users` is managed by Better Auth (see src/lib/auth.ts, `user.modelName` and
 * `additionalFields`). It is NOT created or validated here: this file only
 * describes the document for TypeScript and declares the index we rely on.
 */

export const USER_ROLES = ["customer", "vendor", "admin"] as const;
export const SUBSCRIPTION_PLANS = ["free", "premium"] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

export interface UserDoc {
  _id: ObjectId;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  role: UserRole;
  isBlocked: boolean;
  businessName?: string | null;
  subscriptionPlan: SubscriptionPlan;
  /** null (or missing on users created before this field existed) means "never subscribed". */
  subscriptionExpiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const usersDefinition: CollectionDefinition = {
  name: COLLECTIONS.users,
  indexes: [
    // Better Auth already creates this exact index (same name, key and options),
    // so ensuring it here is a no-op when it exists.
    { name: "users_email_uidx", key: { email: 1 }, unique: true },
  ],
};
