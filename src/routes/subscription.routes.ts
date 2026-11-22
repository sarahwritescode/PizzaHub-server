import { Router } from "express";

import { requireRole } from "../middleware/auth.js";
import { createCheckout, getSubscription } from "../controllers/subscription.controller.js";

/**
 * A vendor's Premium subscription. Mounted at /api/vendor/subscription.
 * requireRole("vendor") = verify the JWT/session, load the user from the database, refuse blocked
 * accounts, check the role. Customers and admins get 403, anonymous callers 401.
 */
const router = Router();

router.use(requireRole("vendor"));

router.get("/", getSubscription);
router.post("/checkout", createCheckout);

export default router;
