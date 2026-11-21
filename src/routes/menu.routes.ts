import { Router } from "express";

import {
  getCategories,
  getFeaturedMenuItems,
  getMenuItemById,
  getMenuItems,
} from "../controllers/menu.controller.js";

/** Public (no login) menu endpoints. Mounted at /api/menu-items. */
export const menuItemsRouter = Router();

menuItemsRouter.get("/", getMenuItems);

// Must stay above "/:id", otherwise "featured" would be read as an id.
menuItemsRouter.get("/featured", getFeaturedMenuItems);

menuItemsRouter.get("/:id", getMenuItemById);

/** Mounted at /api/categories. */
export const categoriesRouter = Router();

categoriesRouter.get("/", getCategories);
