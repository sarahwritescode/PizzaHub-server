import type {
  ErrorRequestHandler,
} from "express";

const errorHandler: ErrorRequestHandler = (
  error,
  _req,
  res,
  _next
) => {
  console.error("Server Error:", error);

  const statusCode =
    typeof error.status === "number" ? error.status : 500;

  res.status(statusCode).json({
    success: false,
    message:
      statusCode === 500
        ? "Internal server error"
        : error.message,
  });
};

export default errorHandler;