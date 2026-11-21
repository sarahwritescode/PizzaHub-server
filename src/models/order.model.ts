import type { ObjectId } from "mongodb";
import { z } from "zod";

import {
  bson,
  COLLECTIONS,
  dateSchema,
  nonEmptyString,
  objectIdSchema,
  type CollectionDefinition,
} from "./common.js";

export const ORDER_STATUSES = ["pending", "accepted", "rejected", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** A complete order as stored. Defaults: status "pending", createdAt now. */
export const orderSchema = z.object({
  itemId: objectIdSchema, // references menuItems._id
  vendorId: objectIdSchema, // references users._id
  customerId: objectIdSchema, // references users._id
  deliveryDate: dateSchema,
  deliveryAddress: nonEmptyString,
  message: nonEmptyString.optional(),
  status: z.enum(ORDER_STATUSES).default("pending"),
  createdAt: z.date().default(() => new Date()),
});

/** What an API client may send. `status` and `createdAt` are set by the server. */
export const createOrderSchema = orderSchema
  .omit({ status: true, createdAt: true })
  .strict();

export type Order = z.output<typeof orderSchema>;
export type OrderDoc = Order & { _id: ObjectId };

/** Validate API input and return a document ready for `insertOne`. */
export const buildOrder = (input: unknown): Order =>
  orderSchema.parse(createOrderSchema.parse(input));

export const ordersDefinition: CollectionDefinition = {
  name: COLLECTIONS.orders,

  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "itemId",
        "vendorId",
        "customerId",
        "deliveryDate",
        "deliveryAddress",
        "status",
        "createdAt",
      ],
      properties: {
        itemId: bson.objectId,
        vendorId: bson.objectId,
        customerId: bson.objectId,
        deliveryDate: bson.date,
        deliveryAddress: bson.string,
        message: { bsonType: "string" },
        status: bson.enumOf(ORDER_STATUSES),
        createdAt: bson.date,
      },
    },
  },

  indexes: [
    { name: "orders_customerId_createdAt_idx", key: { customerId: 1, createdAt: -1 } },
    { name: "orders_vendorId_status_idx", key: { vendorId: 1, status: 1 } },
    {
      name: "orders_itemId_customerId_deliveryDate_status_idx",
      key: { itemId: 1, customerId: 1, deliveryDate: 1, status: 1 },
    },
  ],
};
