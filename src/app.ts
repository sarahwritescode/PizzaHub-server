

import express from "express";
import cors from "cors";
import helmet from "helmet";

import { toNodeHandler } from "better-auth/node";

import { ALLOWED_ORIGINS } from "./config/env.js";
import { connectDB } from "./config/db.js";
import { initializeDatabase } from "./config/initDatabase.js";
import { auth } from "./lib/auth.js";

import healthRoutes from "./routes/health.routes.js";
import testRoutes from "./routes/test.routes.js";
import { categoriesRouter, menuItemsRouter } from "./routes/menu.routes.js";
import vendorMenuRouter from "./routes/vendorMenu.routes.js";
import uploadRouter from "./routes/upload.routes.js";
import adminMenuRouter from "./routes/adminMenu.routes.js";
import notFound from "./middleware/notFound.js";
import errorHandler from "./middleware/errorHandler.js";

const app = express();

// Security middleware
app.use(helmet());

// CORS configuration
app.use(
  cors({
    origin: [...ALLOWED_ORIGINS], // exact origins only: never "*", never a blind reflection
    credentials: true,
  })
);

// Vercel runs this file (app.ts), not server.ts, so server.ts never gets to
// connect the database there. Connect lazily, once per cold start; locally
// server.ts has already connected and connectDB() just returns.
let ready: Promise<unknown> | undefined;

app.use(async (_req, _res, next) => {
  try {
    ready ??= connectDB().then(() => initializeDatabase());
    await ready;
    next();
  } catch (error) {
    ready = undefined; // try again on the next request
    next(error);
  }
});

// Better Auth handler
// Express 5 syntax
app.all("/api/auth/*splat", toNodeHandler(auth));

// Body parsing middleware
// Must be after Better Auth handler
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.use("/api/health", healthRoutes);

// Auth / role test endpoints
app.use("/api/test", testRoutes);

// Public menu (no login required)
app.use("/api/menu-items", menuItemsRouter);
app.use("/api/categories", categoriesRouter);

// Vendor menu management (vendor login required)
app.use("/api/vendor/menu-items", vendorMenuRouter);

// Vendor image upload to ImgBB (vendor login required)
app.use("/api/vendor/upload-image", uploadRouter);

// Admin menu approval / rejection / moderation (admin login required)
app.use("/api/admin/menu-items", adminMenuRouter);

// 404 handler
app.use(notFound);

// Global error handler
app.use(errorHandler);

export default app;
