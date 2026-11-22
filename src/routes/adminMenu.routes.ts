import { Router } from "express";

import { requireRole } from "../middleware/auth.js";
import {
  approveMenuItem,
  deleteMenuItem,
  getAllMenuItems,
  rejectMenuItem,
  updateMenuItemStatus,
} from "../controllers/adminMenu.controller.js";

/**
 * Menu moderation for admins. Mounted at /api/admin/menu-items.
 * requireRole("admin") = verify the JWT/session, load the user from the
 * database, refuse blocked accounts, then check the role. Customers and
 * vendors get 403, anonymous callers 401, blocked admins 403 ACCOUNT_BLOCKED.
 */
const router = Router();

router.use(requireRole("admin"));

router.get("/", getAllMenuItems);
router.patch("/:id/approve", approveMenuItem);
router.patch("/:id/reject", rejectMenuItem);
router.patch("/:id/status", updateMenuItemStatus);
router.delete("/:id", deleteMenuItem);

export default router;
