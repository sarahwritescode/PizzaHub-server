

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
import orderRouter from "./routes/order.routes.js";
import vendorOrderRouter from "./routes/vendorOrder.routes.js";
import subscriptionRouter from "./routes/subscription.routes.js";
import {
  adminDashboardRouter,
  adminTransactionsRouter,
  adminUsersRouter,
  adminVendorsRouter,
} from "./routes/admin.routes.js";
import { stripeWebhook } from "./controllers/stripeWebhook.controller.js";
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

// Stripe webhook. Public, protected only by Stripe's signature, which is computed over the RAW body.
// So it is mounted with express.raw() BEFORE express.json(): once the JSON parser has run, the exact
// bytes are gone and no signature could be verified. Everything below still gets the normal parsers.
app.post("/api/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), stripeWebhook);

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

// Admin dashboard statistics, user management (block/unblock) and read-only transactions (admin login required)
app.use("/api/admin/dashboard", adminDashboardRouter);
app.use("/api/admin/users", adminUsersRouter);
app.use("/api/admin/vendors", adminVendorsRouter);
app.use("/api/admin/transactions", adminTransactionsRouter);

// Customer orders (customer login required)
app.use("/api/orders", orderRouter);

// Vendor order management: see and accept/reject orders for own items (vendor login required)
app.use("/api/vendor/orders", vendorOrderRouter);

// Vendor Premium subscription: status and Stripe Checkout (vendor login required)
app.use("/api/vendor/subscription", subscriptionRouter);

// 404 handler
app.use(notFound);

// Global error handler
app.use(errorHandler);

export default app;
