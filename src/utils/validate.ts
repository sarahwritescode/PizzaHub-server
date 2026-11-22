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
      result.error.issues.flatMap((issue) =>
        // A strict schema reports all unknown keys in one issue with an empty
        // path: list each key by name so the client sees which field is refused.
        issue.code === "unrecognized_keys"
          ? issue.keys.map((key) => ({
              field: [...issue.path, key].join("."),
              message: "This field is not allowed",
            }))
          : [{ field: issue.path.join("."), message: issue.message }]
      )
    );
  }

  return result.data;
};
