import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";

import { HttpError } from "../utils/httpError.js";
import { IMAGE_FIELD, MAX_IMAGE_BYTES, MAX_IMAGE_FILES } from "../validations/imageUpload.validation.js";

/**
 * Reads multipart/form-data into memory (no temp files, so there is nothing to
 * clean up and no client-chosen path is ever used). The limits below are hard
 * limits enforced while the request is read, so a huge upload is cut off:
 * at most 5 files of 5 MB = 25 MB in memory per request.
 */
const parser = multer({
  storage: multer.memoryStorage(),
  defParamCharset: "utf8",
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: MAX_IMAGE_FILES,
    fields: 10,
    fieldSize: 1024,
    parts: MAX_IMAGE_FILES + 10,
  },
}).array(IMAGE_FIELD, MAX_IMAGE_FILES);

const mapMulterError = (error: unknown): unknown => {
  // Anything that is not a MulterError is busboy failing to read the body
  // ("Malformed part header", "Unexpected end of form", ...). With in-memory
  // storage there is no server-side cause, so it is always the client's fault.
  if (!(error instanceof multer.MulterError)) {
    return new HttpError(400, "The upload request is malformed.", "INVALID_UPLOAD");
  }

  switch (error.code) {
    case "LIMIT_FILE_SIZE":
      return new HttpError(
        413,
        `Each image must be at most ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`,
        "FILE_TOO_LARGE",
        [{ field: error.field ?? IMAGE_FIELD, message: "File is larger than the 5 MB limit" }]
      );
    case "LIMIT_FILE_COUNT":
      return new HttpError(400, `You can upload at most ${MAX_IMAGE_FILES} images at once.`, "TOO_MANY_FILES");
    case "LIMIT_UNEXPECTED_FILE":
      // Either another field name, or a 6th file in the "images" field.
      return error.field === IMAGE_FIELD
        ? new HttpError(400, `You can upload at most ${MAX_IMAGE_FILES} images at once.`, "TOO_MANY_FILES")
        : new HttpError(
            400,
            `Unexpected file field "${error.field ?? ""}". Send the files in the "${IMAGE_FIELD}" field.`,
            "UNEXPECTED_FIELD"
          );
    default:
      return new HttpError(400, "Invalid upload request.", "INVALID_UPLOAD");
  }
};

export const parseImages: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  parser(req, res, (error?: unknown) => {
    if (error) return next(mapMulterError(error));
    next();
  });
};
