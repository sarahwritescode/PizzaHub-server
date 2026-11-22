import { z } from "zod";

import { MENU_ITEM_STATUSES } from "../models/index.js";
import { DEFAULT_LIMIT, MAX_LIMIT, MAX_PAGE, optionalText, positiveInteger } from "./menu.validation.js";

/**
 * GET /api/admin/menu-items
 * A repeated key (?status=a&status=b) arrives as an array and is rejected.
 */
export const adminMenuQuerySchema = z.object({
  status: z.enum(MENU_ITEM_STATUSES).optional(),
  category: optionalText,
  search: optionalText, // matches the item name only
  page: positiveInteger(MAX_PAGE).default(1),
  limit: positiveInteger(MAX_LIMIT).default(DEFAULT_LIMIT),
});

/**
 * PATCH .../approve and .../reject take no body. An empty or missing body is
 * fine; any field (for example a rejection `reason`, which the schema has no
 * place to store) is refused loudly instead of being silently dropped.
 */
export const emptyBodySchema = z.strictObject({});

/** PATCH /api/admin/menu-items/:id/status */
export const updateStatusSchema = z.strictObject({
  status: z.enum(MENU_ITEM_STATUSES),
});

export type AdminMenuQuery = z.output<typeof adminMenuQuerySchema>;
