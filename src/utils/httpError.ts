/**
 * An error whose status code and message are safe to show to the API client.
 * Thrown by controllers/services and turned into JSON by middleware/errorHandler.ts.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
