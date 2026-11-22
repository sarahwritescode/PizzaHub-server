import { ObjectId } from "mongodb";
import type { Request, Response } from "express";

import * as vendorMenu from "../services/vendorMenu.service.js";
import { parseWith } from "../utils/validate.js";
import { menuItemParamsSchema } from "../validations/menu.validation.js";
import {
  availabilitySchema,
  createVendorMenuItemSchema,
  updateVendorMenuItemSchema,
  vendorMenuQuerySchema,
} from "../validations/vendorMenu.validation.js";

// These handlers run behind requireRole("vendor"), so req.auth is always set.
// The vendor is the verified, database-loaded user: never a value from the request.
const vendorIdOf = (req: Request) => new ObjectId(req.auth!.user.id);

export const getMyMenuItems = async (req: Request, res: Response) => {
  const query = parseWith(vendorMenuQuerySchema, req.query);
  const { items, pagination } = await vendorMenu.listVendorMenuItems(vendorIdOf(req), query);

  res.status(200).json({
    success: true,
    message: "Your menu items fetched successfully",
    data: items,
    pagination,
  });
};

export const createMenuItem = async (req: Request, res: Response) => {
  const input = parseWith(createVendorMenuItemSchema, req.body);
  const item = await vendorMenu.createVendorMenuItem(vendorIdOf(req), input);

  res.status(201).json({
    success: true,
    message: "Menu item created successfully. It will be visible after admin approval.",
    data: item,
  });
};

export const updateMenuItem = async (req: Request, res: Response) => {
  const { id } = parseWith(menuItemParamsSchema, req.params);
  const input = parseWith(updateVendorMenuItemSchema, req.body);

  const { item, changed, previousStatus } = await vendorMenu.updateVendorMenuItem(
    vendorIdOf(req),
    id,
    input
  );

  let message = "Menu item updated successfully";

  if (!changed) {
    message = "No changes: the item already has these values";
  } else if (previousStatus === "approved" || previousStatus === "inactive") {
    message = "Menu item updated. It is pending approval again and hidden from the public menu until approved.";
  } else if (previousStatus === "rejected") {
    message = "Menu item updated and resubmitted for approval";
  }

  res.status(200).json({ success: true, message, data: item });
};

export const updateMenuItemAvailability = async (req: Request, res: Response) => {
  const { id } = parseWith(menuItemParamsSchema, req.params);
  const { isActive } = parseWith(availabilitySchema, req.body);

  const { item, changed } = await vendorMenu.setVendorMenuItemAvailability(
    vendorIdOf(req),
    id,
    isActive
  );

  let message = isActive ? "Menu item is already active" : "Menu item is already inactive";

  if (changed) {
    message = isActive
      ? "Menu item activated and visible on the public menu"
      : "Menu item deactivated and hidden from the public menu";
  }

  res.status(200).json({ success: true, message, data: item });
};

export const deleteMenuItem = async (req: Request, res: Response) => {
  const { id } = parseWith(menuItemParamsSchema, req.params);
  await vendorMenu.deleteVendorMenuItem(vendorIdOf(req), id);

  res.status(200).json({
    success: true,
    message: "Menu item deleted successfully",
    data: { _id: id },
  });
};
