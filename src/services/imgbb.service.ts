import { randomUUID } from "node:crypto";

import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

// Official ImgBB API v1: POST multipart/form-data, `key` in the query string,
// the file in the `image` field. https://api.imgbb.com/
const IMGBB_UPLOAD_URL = "https://api.imgbb.com/1/upload";
const TIMEOUT_MS = 20_000;

export interface HostedImage {
  /** Full-size image URL: this is the one to store in a menu item's `images`. */
  url: string;
  /** Page-friendly (resized) URL, when ImgBB provides one. */
  display_url?: string;
}

/**
 * ImgBB's `delete_url` is deliberately NOT returned: anyone holding it can
 * delete the picture, and nothing in this API uses it.
 */

const asHttpsUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;

  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
};

const fail = (status: number, code: string, message: string, logDetail: string) => {
  // The API key is never part of what is logged or returned.
  console.error(`[imgbb] ${code}: ${logDetail}`);
  return new HttpError(status, message, code);
};

/** Throws 503 UPLOAD_NOT_CONFIGURED when the server has no IMGBB_API_KEY. */
export const assertUploadConfigured = (): string => {
  const key = env.IMGBB_API_KEY;

  if (!key) {
    throw new HttpError(503, "Image upload is not configured on the server.", "UPLOAD_NOT_CONFIGURED");
  }

  return key;
};

/**
 * Uploads one image to ImgBB and returns its public URL.
 * Every failure becomes an HttpError that is safe to show to the client:
 *   503 UPLOAD_NOT_CONFIGURED      no IMGBB_API_KEY
 *   502 UPLOAD_SERVICE_CONFIG_ERROR  ImgBB rejected the key (server misconfiguration)
 *   503 UPLOAD_SERVICE_BUSY        ImgBB rate limit
 *   504 UPLOAD_TIMEOUT             no answer within 20 s
 *   502 UPLOAD_SERVICE_UNAVAILABLE network error / unreadable answer
 *   502 UPLOAD_SERVICE_ERROR       any other refusal by ImgBB
 */
export const uploadToImgbb = async (image: {
  buffer: Buffer;
  mime: string;
  extension: string;
}): Promise<HostedImage> => {
  const key = assertUploadConfigured();

  // The client's own filename is never forwarded; ImgBB gets a generated one.
  const form = new FormData();
  form.append(
    "image",
    new Blob([new Uint8Array(image.buffer)], { type: image.mime }),
    `pizzahub-${randomUUID()}.${image.extension}`
  );

  let response: Response;

  try {
    response = await fetch(`${IMGBB_UPLOAD_URL}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // Log only the error kind: the fetch URL contains the key.
    const name = error instanceof Error ? error.name : "unknown";

    if (name === "TimeoutError" || name === "AbortError") {
      throw fail(
        504,
        "UPLOAD_TIMEOUT",
        "The image service took too long to respond. Please try again.",
        `no response within ${TIMEOUT_MS / 1000}s`
      );
    }

    const cause = error instanceof Error ? (error.cause as { code?: string } | undefined)?.code : undefined;
    throw fail(
      502,
      "UPLOAD_SERVICE_UNAVAILABLE",
      "Could not reach the image service. Please try again.",
      `network error (${name}${cause ? `, ${cause}` : ""})`
    );
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  const json = (body ?? {}) as {
    success?: boolean;
    data?: { url?: unknown; display_url?: unknown };
    error?: { message?: string; code?: number };
  };

  if (response.ok && json.success === true) {
    const url = asHttpsUrl(json.data?.url);

    if (!url) {
      throw fail(
        502,
        "UPLOAD_SERVICE_ERROR",
        "The image service returned an unexpected answer.",
        "success response without a usable data.url"
      );
    }

    const displayUrl = asHttpsUrl(json.data?.display_url);
    return displayUrl ? { url, display_url: displayUrl } : { url };
  }

  const detail = `HTTP ${response.status}, provider code ${json.error?.code ?? "n/a"}: ${json.error?.message ?? "no message"}`;

  // ImgBB answers an invalid / missing key with HTTP 400 and error.code 100.
  if (json.error?.code === 100 || /api v1 key/i.test(json.error?.message ?? "")) {
    throw fail(
      502,
      "UPLOAD_SERVICE_CONFIG_ERROR",
      "The image upload service is not configured correctly. Please contact support.",
      `${detail} (check IMGBB_API_KEY)`
    );
  }

  if (response.status === 429) {
    throw fail(503, "UPLOAD_SERVICE_BUSY", "The image service is busy. Please try again in a moment.", detail);
  }

  throw fail(502, "UPLOAD_SERVICE_ERROR", "The image service could not process this upload.", detail);
};
