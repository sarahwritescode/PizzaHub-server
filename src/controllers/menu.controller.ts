import type { Request, Response } from "express";

import * as menuService from "../services/menu.service.js";
import { HttpError } from "../utils/httpError.js";
import { parseWith } from "../utils/validate.js";
import { menuItemParamsSchema, menuItemsQuerySchema } from "../validations/menu.validation.js";

// Express 5 forwards a rejected promise from an async handler to the error handler.

export const getMenuItems = async (req: Request, res: Response) => {
  const query = parseWith(menuItemsQuerySchema, req.query);
  const { items, pagination } = await menuService.listPublicMenuItems(query);

  res.status(200).json({
    success: true,
    message: "Menu items fetched successfully",
    data: items,
    pagination,
  });
};

export const getFeaturedMenuItems = async (_req: Request, res: Response) => {
  const items = await menuService.listFeaturedMenuItems();

  res.status(200).json({
    success: true,
    message: "Featured menu items fetched successfully",
    data: items,
  });
};

export const getMenuItemById = async (req: Request, res: Response) => {
  const { id } = parseWith(menuItemParamsSchema, req.params);
  const item = await menuService.findPublicMenuItem(id);

  if (!item) {
    throw new HttpError(404, "Menu item not found", "MENU_ITEM_NOT_FOUND");
  }

  res.status(200).json({
    success: true,
    message: "Menu item fetched successfully",
    data: item,
  });
};

export const getCategories = async (_req: Request, res: Response) => {
  const categories = await menuService.listPublicCategories();

  res.status(200).json({
    success: true,
    message: "Categories fetched successfully",
    data: categories,
  });
};
