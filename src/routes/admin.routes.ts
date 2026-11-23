import { Router } from "express";

import {
  blockUser,
  dashboard,
  getTransactions,
  getUserById,
  getUsers,
  getVendors,
  unblockUser,
} from "../controllers/admin.controller.js";
import { requireRole } from "../middleware/auth.js";

/**
 * Admin management. Three routers, each mounted on its own path in app.ts (so an unknown
 * /api/admin/... path is still a plain 404 and not a 401), each behind requireRole("admin"):
 * verify the JWT/session, load the user from the database, refuse blocked accounts, then check
 * the role. Anonymous callers get 401, customers and vendors 403, blocked admins 403 ACCOUNT_BLOCKED.
 */

// GET /api/admin/dashboard
export const adminDashboardRouter = Router();
adminDashboardRouter.use(requireRole("admin"));
adminDashboardRouter.get("/", dashboard);

// /api/admin/users
export const adminUsersRouter = Router();
adminUsersRouter.use(requireRole("admin"));
adminUsersRouter.get("/", getUsers);
adminUsersRouter.get("/:id", getUserById);
adminUsersRouter.patch("/:id/block", blockUser);
adminUsersRouter.patch("/:id/unblock", unblockUser);

// GET /api/admin/vendors. Read-only list of every vendor (no pagination), for admin pickers and filters.
export const adminVendorsRouter = Router();
adminVendorsRouter.use(requireRole("admin"));
adminVendorsRouter.get("/", getVendors);

// GET /api/admin/transactions. Read-only on purpose: no POST/PATCH/PUT/DELETE exists for transactions.
export const adminTransactionsRouter = Router();
adminTransactionsRouter.use(requireRole("admin"));
adminTransactionsRouter.get("/", getTransactions);
