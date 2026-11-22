import { ObjectId } from "mongodb";
import { z } from "zod";

import { DEFAULT_LIMIT, MAX_LIMIT, MAX_PAGE, menuItemParamsSchema, positiveInteger } from "./menu.validation.js";

/** Route params of /api/orders/:id: the same 24-hex-character ObjectId rule as the menu routes. */
export const orderParamsSchema = menuItemParamsSchema;

const todayUtc = () => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

/**
 * "YYYY-MM-DD" only (a real calendar day: 2026-02-30 is refused), stored as that day at
 * 00:00 UTC. A time of day is not accepted, so "same delivery date" always means the
 * same day and the duplicate-order index cannot be dodged by changing the time.
 * Today is allowed, the past is not.
 */
const deliveryDate = z.iso
  .date("Must be a real date in the format YYYY-MM-DD")
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((date) => date.getTime() >= todayUtc(), "Delivery date cannot be in the past");

/**
 * POST /api/orders. Strict: vendorId, customerId, status, createdAt (or anything else)
 * make the request fail instead of being ignored, so nothing the client sends can
 * reach the stored order except these four fields.
 */
export const createOrderBodySchema = z.strictObject({
  itemId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, "Must be a valid MongoDB ObjectId (24 hex characters)")
    .transform((value) => new ObjectId(value)),
  deliveryDate,
  deliveryAddress: z.string().trim().min(1, "Delivery address is required").max(300, "Must be at most 300 characters"),
  // Optional: missing, empty or blank all mean "no message".
  message: z
    .string()
    .trim()
    .max(500, "Must be at most 500 characters")
    .transform((value) => (value === "" ? undefined : value))
    .optional(),
});

/** PATCH /api/orders/:id/cancel takes no body (an empty {} is fine). */
export const emptyBodySchema = z.strictObject({});

/** GET /api/orders/my-orders */
export const myOrdersQuerySchema = z.object({
  page: positiveInteger(MAX_PAGE).default(1),
  limit: positiveInteger(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export type CreateOrderInput = z.output<typeof createOrderBodySchema>;
export type MyOrdersQuery = z.output<typeof myOrdersQuerySchema>;
