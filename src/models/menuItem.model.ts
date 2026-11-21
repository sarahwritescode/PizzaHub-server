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

export const MENU_ITEM_STATUSES = ["pending", "approved", "rejected", "inactive"] as const;
export type MenuItemStatus = (typeof MENU_ITEM_STATUSES)[number];

/** A complete menu item as stored. Defaults: status "pending", createdAt now. */
export const menuItemSchema = z.object({
  vendorId: objectIdSchema, // references users._id
  itemName: nonEmptyString,
  category: nonEmptyString,
  description: nonEmptyString,
  price: positiveNumber,
  location: nonEmptyString,
  images: z.array(nonEmptyString),
  status: z.enum(MENU_ITEM_STATUSES).default("pending"),
  createdAt: z.date().default(() => new Date()),
});

/** What an API client may send. `status` and `createdAt` are set by the server, never by the client. */
export const createMenuItemSchema = menuItemSchema
  .omit({ status: true, createdAt: true })
  .strict();

export type MenuItem = z.output<typeof menuItemSchema>;
export type MenuItemDoc = MenuItem & { _id: ObjectId };

/** Validate API input and return a document ready for `insertOne`. */
export const buildMenuItem = (input: unknown): MenuItem =>
  menuItemSchema.parse(createMenuItemSchema.parse(input));

export const menuItemsDefinition: CollectionDefinition = {
  name: COLLECTIONS.menuItems,

  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "vendorId",
        "itemName",
        "category",
        "description",
        "price",
        "location",
        "images",
        "status",
        "createdAt",
      ],
      properties: {
        vendorId: bson.objectId,
        itemName: bson.string,
        category: bson.string,
        description: bson.string,
        price: bson.positiveNumber,
        location: bson.string,
        images: { bsonType: "array", items: { bsonType: "string" } },
        status: bson.enumOf(MENU_ITEM_STATUSES),
        createdAt: bson.date,
      },
    },
  },

  indexes: [
    { name: "menuItems_vendorId_idx", key: { vendorId: 1 } },
    { name: "menuItems_status_createdAt_idx", key: { status: 1, createdAt: -1 } },
    { name: "menuItems_category_status_idx", key: { category: 1, status: 1 } },
    { name: "menuItems_price_idx", key: { price: 1 } },
  ],
};
