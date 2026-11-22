import type { Request, Response } from "express";

import { HttpError } from "../utils/httpError.js";
import { assertUploadConfigured, uploadToImgbb, type HostedImage } from "../services/imgbb.service.js";
import { IMAGE_FIELD, validateImageFiles } from "../validations/imageUpload.validation.js";

/**
 * POST /api/vendor/upload-image
 *
 * All files are validated first; nothing is sent to ImgBB unless every one is
 * valid. The uploads then run in parallel.
 *
 * Partial failure policy (ImgBB can fail for one file and not another): the
 * request counts as FAILED, with the status/code of the first failure, a
 * per-file `errors` list, and `data.images` holding the files that DID upload
 * (with their `index`), so the client can reuse them and retry only the rest.
 * The uploaded pictures stay on ImgBB; ImgBB images that no menu item
 * references are harmless.
 */
export const uploadImages = async (req: Request, res: Response) => {
  const files = Array.isArray(req.files) ? req.files : [];
  const images = validateImageFiles(files);
  // After validation on purpose: a bad request is still told it is bad even
  // while the key is missing, and a good one gets a clear 503.
  assertUploadConfigured();

  const results = await Promise.allSettled(images.map((image) => uploadToImgbb(image)));

  const uploaded: { index: number; image: HostedImage }[] = [];
  const failed: { index: number; error: HttpError }[] = [];

  results.forEach((result, position) => {
    const index = images[position]!.index;

    if (result.status === "fulfilled") {
      uploaded.push({ index, image: result.value });
    } else if (result.reason instanceof HttpError) {
      failed.push({ index, error: result.reason });
    } else {
      console.error("[imgbb] unexpected error:", result.reason instanceof Error ? result.reason.name : "unknown");
      failed.push({ index, error: new HttpError(500, "Internal server error", "UPLOAD_SERVICE_ERROR") });
    }
  });

  if (failed.length === 0) {
    return res.status(201).json({
      success: true,
      message: uploaded.length === 1 ? "Image uploaded successfully" : "Images uploaded successfully",
      data: { images: uploaded.map(({ image }) => image) },
    });
  }

  const first = failed[0]!.error;
  const status = first.status === 500 ? 502 : first.status;

  return res.status(status).json({
    success: false,
    message:
      images.length === 1
        ? first.message
        : `${failed.length} of ${images.length} images could not be uploaded. ${first.message}`,
    code: first.code,
    errors: failed.map(({ index, error }) => ({
      field: `${IMAGE_FIELD}[${index}]`,
      code: error.code,
      message: error.message,
    })),
    data: { images: uploaded.map(({ index, image }) => ({ index, ...image })) },
  });
};
