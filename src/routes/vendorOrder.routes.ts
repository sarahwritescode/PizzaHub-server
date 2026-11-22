import { Router } from "express";

import { requireRole } from "../middleware/auth.js";
import { acceptOrder, getVendorOrders, rejectOrder } from "../controllers/vendorOrder.controller.js";

/**
 * Orders for a vendor's own menu items. Mounted at /api/vendor/orders.
 * requireRole("vendor") = verify the JWT/session, load the user from the database, refuse
 * blocked accounts, check the role. Customers and admins get 403, anonymous callers 401.
 */
const router = Router();

router.use(requireRole("vendor"));

router.get("/", getVendorOrders);
router.patch("/:id/accept", acceptOrder);
router.patch("/:id/reject", rejectOrder);

export default router;
