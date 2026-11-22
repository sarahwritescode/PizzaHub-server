import type { Request, Response } from "express";

import * as adminMenu from "../services/adminMenu.service.js";
import { parseWith } from "../utils/validate.js";
import {
  adminMenuQuerySchema,
  emptyBodySchema,
  updateStatusSchema,
} from "../validations/adminMenu.validation.js";
import { menuItemParamsSchema } from "../validations/menu.validation.js";

// These handlers run behind requireRole("admin"): only a signed-in, non-blocked admin gets here.
// An admin acts on any vendor's item, so there is deliberately no vendorId filter.

export const getAllMenuItems = async (req: Request, res: Response) => {
  const query = parseWith(adminMenuQuerySchema, req.query);
  const { items, pagination } = await adminMenu.listAdminMenuItems(query);

  res.status(200).json({
    success: true,
    message: "Menu items fetched successfully",
    data: items,
    pagination,
  });
};

export const approveMenuItem = async (req: Request, res: Response) => {
  const { id } = parseWith(menuItemParamsSchema, req.params);
  parseWith(emptyBodySchema, req.body ?? {});
  const item = await adminMenu.changeMenuItemStatus(id, "approved");

  res.status(200).json({
    success: true,
    message: "Menu item approved. It is now visible on the public menu.",
    data: item,
  });
};

export const rejectMenuItem = async (req: Request, res: Response) => {
  const { id } = parseWith(menuItemParamsSchema, req.params);
  parseWith(emptyBodySchema, req.body ?? {});
  const item = await adminMenu.changeMenuItemStatus(id, "rejected");

  res.status(200).json({
    success: true,
    message: "Menu item rejected. The vendor can edit it to resubmit it for approval.",
    data: item,
  });
};

export const updateMenuItemStatus = async (req: Request, res: Response) => {
  const { id } = parseWith(menuItemParamsSchema, req.params);
  const { status } = parseWith(updateStatusSchema, req.body);
  const item = await adminMenu.changeMenuItemStatus(id, status);

  res.status(200).json({
    success: true,
    message: `Menu item status changed to ${status}`,
    data: item,
  });
};

export const deleteMenuItem = async (req: Request, res: Response) => {
  const { id } = parseWith(menuItemParamsSchema, req.params);
  await adminMenu.deleteAdminMenuItem(id);

  res.status(200).json({
    success: true,
    message: "Menu item deleted successfully",
    data: { _id: id },
  });
};
