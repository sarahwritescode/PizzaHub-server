import { Router } from "express";
import { getDB } from "../config/db.js";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const db = getDB();

    await db.command({ ping: 1 });

    res.status(200).json({
      success: true,
      message: "PizzaHub API is running",
      database: "connected",
    });
  } catch (error) {
    next(error);
  }
});

export default router;