import type { z } from "zod";

import { HttpError } from "./httpError.js";

/**
 * Parses `input` with a Zod schema. On failure throws a 400 HttpError that
 * lists every problem as { field, message }.
 */
export const parseWith = <S extends z.ZodType>(schema: S, input: unknown): z.output<S> => {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new HttpError(
      400,
      "Validation failed",
      "VALIDATION_ERROR",
      result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }))
    );
  }

  return result.data;
};
