import { HttpError } from "../utils/httpError.js";

export const MAX_IMAGE_FILES = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image
export const IMAGE_FIELD = "images";

export type ImageKind = "jpeg" | "png" | "webp";

const KINDS: Record<ImageKind, { mime: string; extension: string }> = {
  jpeg: { mime: "image/jpeg", extension: "jpg" },
  png: { mime: "image/png", extension: "png" },
  webp: { mime: "image/webp", extension: "webp" },
};

// MIME types the client may declare. "image/jpg" is not a registered type but
// some tools send it for .jpg files.
const DECLARED_MIME_TO_KIND: Record<string, ImageKind> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

/** What the file really is, judged by its first bytes (not by name or declared type). */
export const detectImageKind = (buffer: Buffer): ImageKind | null => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }

  // WebP is a RIFF container: "RIFF" <4 byte size> "WEBP"
  if (
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }

  return null;
};

export interface ValidImage {
  /** Position in the request, so a failure can be reported for the right file. */
  index: number;
  buffer: Buffer;
  /** Real type, from the file signature. */
  mime: string;
  extension: string;
}

interface Problem {
  index: number;
  status: number;
  code: string;
  message: string;
}

/** The client's filename is untrusted: keep only a short, printable base name for messages. */
const safeName = (name: string | undefined): string => {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  // biome-ignore lint: strip control characters
  const printable = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
  return printable || "file";
};

/**
 * Checks every uploaded file and throws one 400/413/415 HttpError that lists
 * all rejected files. Nothing is sent to ImgBB unless every file passes.
 *
 * A file is accepted only if ALL of these hold:
 *   - it is not empty,
 *   - the declared MIME type is image/jpeg, image/jpg, image/png or image/webp,
 *   - its real content (magic bytes) is JPEG, PNG or WebP,
 *   - the real content matches the declared MIME type.
 * (Size and count are enforced earlier, while the upload is being read.)
 */
export const validateImageFiles = (files: Express.Multer.File[]): ValidImage[] => {
  if (files.length === 0) {
    throw new HttpError(
      400,
      `No image received. Send 1 to ${MAX_IMAGE_FILES} files as multipart/form-data in the "${IMAGE_FIELD}" field.`,
      "NO_FILES"
    );
  }

  const valid: ValidImage[] = [];
  const problems: Problem[] = [];

  files.forEach((file, index) => {
    const name = safeName(file.originalname);

    if (file.size === 0 || file.buffer.length === 0) {
      problems.push({ index, status: 400, code: "EMPTY_FILE", message: `"${name}" is empty.` });
      return;
    }

    const declared = DECLARED_MIME_TO_KIND[file.mimetype.toLowerCase()];
    const actual = detectImageKind(file.buffer);

    if (!declared || !actual) {
      problems.push({
        index,
        status: 415,
        code: "UNSUPPORTED_FILE_TYPE",
        message: `"${name}" is not a supported image. Only JPEG, JPG, PNG and WEBP are allowed.`,
      });
      return;
    }

    if (declared !== actual) {
      problems.push({
        index,
        status: 415,
        code: "UNSUPPORTED_FILE_TYPE",
        message: `"${name}" content does not match its declared type (${file.mimetype}).`,
      });
      return;
    }

    valid.push({ index, buffer: file.buffer, mime: KINDS[actual].mime, extension: KINDS[actual].extension });
  });

  if (problems.length > 0) {
    const [first] = problems;

    throw new HttpError(
      first!.status,
      problems.length === 1 ? first!.message : `${problems.length} images were rejected.`,
      first!.code,
      problems.map((problem) => ({ field: `${IMAGE_FIELD}[${problem.index}]`, message: problem.message }))
    );
  }

  return valid;
};
