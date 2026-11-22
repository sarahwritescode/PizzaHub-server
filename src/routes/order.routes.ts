import { Router } from "express";

import { requireRole } from "../middleware/auth.js";
import { cancelOrder, createOrder, getMyOrders, getOrderById } from "../controllers/order.controller.js";

/**
 * A customer's own orders. Mounted at /api/orders.
 * requireRole("customer") = verify the JWT/session, load the user from the database, refuse
 * blocked accounts, check the role. Vendors and admins get 403, anonymous callers 401.
 */
const router = Router();

router.use(requireRole("customer"));

router.post("/", createOrder);

// Must stay above "/:id", otherwise "my-orders" would be read as an id.
router.get("/my-orders", getMyOrders);

router.get("/:id", getOrderById);
router.patch("/:id/cancel", cancelOrder);

export default router;
