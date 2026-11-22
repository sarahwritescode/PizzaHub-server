import { Router } from "express";

import { requireRole } from "../middleware/auth.js";
import { parseImages } from "../middleware/uploadImages.js";
import { uploadImages } from "../controllers/upload.controller.js";

/**
 * Image upload for vendors. Mounted at /api/vendor/upload-image.
 *
 * Order matters: the caller is authenticated and checked for the vendor role
 * BEFORE the body is read, so anonymous users, customers, admins and blocked
 * vendors never get to stream a file to the server.
 */
const router = Router();

router.post("/", requireRole("vendor"), parseImages, uploadImages);

export default router;
