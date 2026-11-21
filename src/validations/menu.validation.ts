import { ObjectId } from "mongodb";
import { z } from "zod";

export const MAX_PAGE = 100_000;
export const DEFAULT_LIMIT = 12;
export const MAX_LIMIT = 50;

/** Optional free-text filter: trimmed, max 100 chars, an empty value means "not set". */
const optionalText = z
  .string()
  .trim()
  .max(100, "Must be at most 100 characters")
  .transform((value) => (value === "" ? undefined : value))
  .optional();

/** "12" -> 12. Rejects "0", "-1", "1.5", "abc", "" and anything above `max`. */
const positiveInteger = (max: number) =>
  z
    .string()
    .regex(/^\d+$/, "Must be a positive whole number")
    .transform(Number)
    .refine((value) => value >= 1 && value <= max, `Must be between 1 and ${max}`);

/**
 * Query string of GET /api/menu-items.
 * A repeated key (?search=a&search=b) arrives as an array and is rejected by z.string().
 */
export const menuItemsQuerySchema = z.object({
  search: optionalText,
  category: optionalText,
  location: optionalText,

  sortBy: z.enum(["price", "createdAt"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),

  page: positiveInteger(MAX_PAGE).default(1),
  limit: positiveInteger(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export type MenuItemsQuery = z.output<typeof menuItemsQuerySchema>;

/** Route params of GET /api/menu-items/:id. */
export const menuItemParamsSchema = z.object({
  id: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, "Must be a valid MongoDB ObjectId (24 hex characters)")
    .transform((value) => new ObjectId(value)),
});
