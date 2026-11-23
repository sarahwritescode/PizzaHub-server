import type { Request, Response } from "express";

import { getDashboard } from "../services/adminDashboard.service.js";
import { listTransactions } from "../services/adminTransaction.service.js";
import { getUser, listUsers, setUserBlocked } from "../services/adminUser.service.js";
import { listVendors } from "../services/adminVendor.service.js";
import { parseWith } from "../utils/validate.js";
import {
  adminTransactionsQuerySchema,
  adminUsersQuerySchema,
  userParamsSchema,
} from "../validations/admin.validation.js";
import { emptyBodySchema, emptyQuerySchema } from "../validations/adminMenu.validation.js";

// These handlers run behind requireRole("admin"): only a signed-in, non-blocked admin gets here.
// The acting admin is req.auth (verified and loaded from the database), never a value from the request.

export const dashboard = async (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "Dashboard fetched successfully",
    data: await getDashboard(),
  });
};

export const getUsers = async (req: Request, res: Response) => {
  const query = parseWith(adminUsersQuerySchema, req.query);
  const { items, pagination } = await listUsers(query);

  res.status(200).json({ success: true, message: "Users fetched successfully", data: items, pagination });
};

export const getUserById = async (req: Request, res: Response) => {
  const { id } = parseWith(userParamsSchema, req.params);

  res.status(200).json({ success: true, message: "User fetched successfully", data: await getUser(id) });
};

export const blockUser = async (req: Request, res: Response) => {
  const { id } = parseWith(userParamsSchema, req.params);
  parseWith(emptyBodySchema, req.body ?? {});
  const user = await setUserBlocked(req.auth!.user.id, id, true);

  res.status(200).json({ success: true, message: "User blocked successfully", data: user });
};

export const unblockUser = async (req: Request, res: Response) => {
  const { id } = parseWith(userParamsSchema, req.params);
  parseWith(emptyBodySchema, req.body ?? {});
  const user = await setUserBlocked(req.auth!.user.id, id, false);

  res.status(200).json({ success: true, message: "User unblocked successfully", data: user });
};

export const getVendors = async (req: Request, res: Response) => {
  parseWith(emptyQuerySchema, req.query);

  res.status(200).json({ success: true, message: "Vendors fetched successfully", data: await listVendors() });
};

export const getTransactions =async (req: Request, res: Response) => {
  const query = parseWith(adminTransactionsQuerySchema, req.query);
  const { items, pagination } = await listTransactions(query);

  res.status(200).json({ success: true, message: "Transactions fetched successfully", data: items, pagination });
};
