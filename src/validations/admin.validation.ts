import { ObjectId } from "mongodb";
import { z } from "zod";

import { TRANSACTION_STATUSES, USER_ROLES } from "../models/index.js";
import { DEFAULT_LIMIT, MAX_LIMIT, MAX_PAGE, optionalText, positiveInteger } from "./menu.validation.js";

const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "Must be a valid MongoDB ObjectId (24 hex characters)")
  .transform((value) => new ObjectId(value));

/** Route params of /api/admin/users/:id/... (the same 24-hex-character rule as every other :id). */
export const userParamsSchema = z.object({ id: objectId });

/**
 * GET /api/admin/users
 * A repeated key (?role=a&role=b) arrives as an array and is rejected.
 * `status`: blocked = isBlocked is true, unblocked = everyone else.
 */
export const adminUsersQuerySchema = z.object({
  search: optionalText, // matches the name or the email
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(["blocked", "unblocked"]).optional(),
  page: positiveInteger(MAX_PAGE).default(1),
  limit: positiveInteger(MAX_LIMIT).default(DEFAULT_LIMIT),
});

/** GET /api/admin/transactions */
export const adminTransactionsQuerySchema = z.object({
  status: z.enum(TRANSACTION_STATUSES).optional(),
  vendorId: objectId.optional(),
  page: positiveInteger(MAX_PAGE).default(1),
  limit: positiveInteger(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export type AdminUsersQuery = z.output<typeof adminUsersQuerySchema>;
export type AdminTransactionsQuery = z.output<typeof adminTransactionsQuerySchema>;
