import type {
  ErrorRequestHandler,
} from "express";

import { HttpError } from "../utils/httpError.js";

const errorHandler: ErrorRequestHandler = (
  error,
  _req,
  res,
  _next
) => {
  const statusCode =
    typeof error.status === "number" ? error.status : 500;

  // Expected client errors (400, 404, ...) are not logged, only real failures.
  if (statusCode >= 500) {
    console.error("Server Error:", error);
  }

  const body: Record<string, unknown> = {
    success: false,
    message:
      statusCode === 500
        ? "Internal server error"
        : error.message,
  };

  // Optional extras from HttpError: a machine-readable code and validation details.
  if (error instanceof HttpError) {
    if (error.code) body.code = error.code;
    if (error.details) body.errors = error.details;
  }

  res.status(statusCode).json(body);
};

export default errorHandler;
