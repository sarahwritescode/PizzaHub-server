import { ObjectId, type Document } from "mongodb";
import { z } from "zod";

/** The four business collections. Better Auth keeps its own (session, account, ...) beside them. */
export const COLLECTIONS = {
  users: "users",
  menuItems: "menuItems",
  orders: "orders",
  transactions: "transactions",
} as const;

export interface IndexDefinition {
  /** Explicit name, so the same index is never created twice under two names. */
  name: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
}

export interface CollectionDefinition {
  name: string;
  /** MongoDB `$jsonSchema` validator applied to the collection (business collections only). */
  validator?: Document;
  indexes: IndexDefinition[];
}

// ---------- Zod building blocks ----------

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/** A 24-char hex string or an ObjectId, always output as a real ObjectId. */
export const objectIdSchema = z
  .union([z.instanceof(ObjectId), z.string()])
  .transform((value, ctx) => {
    if (value instanceof ObjectId) return value;

    if (!OBJECT_ID_PATTERN.test(value)) {
      ctx.addIssue({ code: "custom", message: "Invalid ObjectId" });
      return z.NEVER;
    }

    return new ObjectId(value);
  });

export const nonEmptyString = z.string().trim().min(1);

export const positiveNumber = z.number().positive();

/** A Date, or an ISO string ("2026-12-01" or "2026-12-01T18:00:00Z"). Nothing else (no numbers, no null). */
export const dateSchema = z
  .union([z.date(), z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((value) => (value instanceof Date ? value : new Date(value)));

// ---------- $jsonSchema building blocks ----------

export const bson = {
  objectId: { bsonType: "objectId" },
  string: { bsonType: "string", minLength: 1 },
  date: { bsonType: "date" },
  // JS numbers are stored as int or double depending on their value.
  positiveNumber: {
    bsonType: ["double", "int", "long", "decimal"],
    minimum: 0,
    exclusiveMinimum: true,
  },
  enumOf: (values: readonly string[]) => ({ bsonType: "string", enum: [...values] }),
};
