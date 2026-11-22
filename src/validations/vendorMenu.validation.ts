import { z } from "zod";

import { MENU_ITEM_STATUSES, nonEmptyString } from "../models/index.js";
import { MAX_LIMIT, MAX_PAGE, DEFAULT_LIMIT, positiveInteger } from "./menu.validation.js";

/** http(s) links only: `javascript:`, `data:` and friends are rejected. */
const imageUrl = z.url({ protocol: /^https?$/ }).max(2048);

/**
 * The fields a vendor may write. Anything else (vendorId, status, createdAt,
 * _id, role, subscriptionPlan, ...) makes the request fail: the schemas below are
 * strict, so a protected field is rejected loudly instead of being ignored.
 */
const editableFields = {
  itemName: nonEmptyString.max(100),
  category: nonEmptyString.max(50),
  description: nonEmptyString.max(1000),
  price: z.number().positive().max(1_000_000),
  location: nonEmptyString.max(100),
  images: z.array(imageUrl).min(1, "At least one image is required").max(10),
};

/** POST /api/vendor/menu-items */
export const createVendorMenuItemSchema = z.strictObject(editableFields);

/** PATCH /api/vendor/menu-items/:id (only the fields to change) */
export const updateVendorMenuItemSchema = z
  .strictObject(editableFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Send at least one field to update");

/** PATCH /api/vendor/menu-items/:id/availability */
export const availabilitySchema = z.strictObject({ isActive: z.boolean() });

/** GET /api/vendor/menu-items */
export const vendorMenuQuerySchema = z.object({
  status: z.enum(MENU_ITEM_STATUSES).optional(),
  page: positiveInteger(MAX_PAGE).default(1),
  limit: positiveInteger(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export type CreateVendorMenuItemInput = z.output<typeof createVendorMenuItemSchema>;
export type UpdateVendorMenuItemInput = z.output<typeof updateVendorMenuItemSchema>;
export type VendorMenuQuery = z.output<typeof vendorMenuQuerySchema>;
