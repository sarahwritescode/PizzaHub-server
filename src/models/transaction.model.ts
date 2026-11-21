import type { ObjectId } from "mongodb";
import { z } from "zod";

import {
  bson,
  COLLECTIONS,
  nonEmptyString,
  objectIdSchema,
  positiveNumber,
  type CollectionDefinition,
} from "./common.js";

/**
 * Stripe transactions for the vendor PREMIUM SUBSCRIPTION only.
 * Pizza orders are never paid through Stripe.
 */

export const TRANSACTION_STATUSES = [
  "pending",
  "success",
  "failed",
  "cancelled",
  "expired",
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/** A complete transaction as stored. Defaults: status "pending", subscription id null, createdAt now. */
export const transactionSchema = z.object({
  vendorId: objectIdSchema, // references users._id
  plan: z.literal("premium"),
  amount: positiveNumber,
  // Stripe uses 3-letter ISO codes; stored lower-case ("usd").
  currency: z.string().trim().length(3).toLowerCase(),
  stripeSessionId: nonEmptyString,
  stripeSubscriptionId: nonEmptyString.nullable().default(null),
  status: z.enum(TRANSACTION_STATUSES).default("pending"),
  createdAt: z.date().default(() => new Date()),
});

export type Transaction = z.output<typeof transactionSchema>;
export type TransactionDoc = Transaction & { _id: ObjectId };

export const transactionsDefinition: CollectionDefinition = {
  name: COLLECTIONS.transactions,

  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "vendorId",
        "plan",
        "amount",
        "currency",
        "stripeSessionId",
        "stripeSubscriptionId",
        "status",
        "createdAt",
      ],
      properties: {
        vendorId: bson.objectId,
        plan: { bsonType: "string", enum: ["premium"] },
        amount: bson.positiveNumber,
        currency: bson.string,
        stripeSessionId: bson.string,
        stripeSubscriptionId: { bsonType: ["string", "null"] },
        status: bson.enumOf(TRANSACTION_STATUSES),
        createdAt: bson.date,
      },
    },
  },

  indexes: [
    { name: "transactions_stripeSessionId_uidx", key: { stripeSessionId: 1 }, unique: true },
    { name: "transactions_vendorId_createdAt_idx", key: { vendorId: 1, createdAt: -1 } },
  ],
};
