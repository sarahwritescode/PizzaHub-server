import { Router } from "express";

import { requireRole } from "../middleware/auth.js";
import {
  createMenuItem,
  deleteMenuItem,
  getMyMenuItems,
  updateMenuItem,
  updateMenuItemAvailability,
} from "../controllers/vendorMenu.controller.js";

/**
 * A vendor's own menu items. Mounted at /api/vendor/menu-items.
 * Only a signed-in, non-blocked vendor gets past requireRole: customers and
 * admins get 403, anonymous callers 401.
 */
const router = Router();

router.use(requireRole("vendor"));

router.get("/", getMyMenuItems);
router.post("/", createMenuItem);
router.patch("/:id/availability", updateMenuItemAvailability);
router.patch("/:id", updateMenuItem);
router.delete("/:id", deleteMenuItem);

export default router;
