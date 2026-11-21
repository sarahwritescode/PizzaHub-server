import { Router, type Request, type Response } from "express";

import { requireAuth, requireRole } from "../middleware/auth.js";

/**
 * Endpoints for checking authentication and role-based authorization.
 * They only ever return id, email and role of the verified caller.
 * See docs/AUTH_TESTING.md.
 */
const router = Router();

const whoAmI = (req: Request, res: Response) => {
  const { id, email, role } = req.auth!.user;

  res.status(200).json({ success: true, user: { id, email, role } });
};

// Any signed-in, non-blocked user.
router.get("/protected", requireAuth, whoAmI);

// One endpoint per role, to demonstrate 200 vs 403.
router.get("/admin", requireRole("admin"), whoAmI);
router.get("/vendor", requireRole("vendor"), whoAmI);
router.get("/customer", requireRole("customer"), whoAmI);

export default router;
