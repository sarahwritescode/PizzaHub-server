

import express from "express";
import cors from "cors";
import helmet from "helmet";

import { toNodeHandler } from "better-auth/node";

import { env } from "./config/env.js";
import { auth } from "./lib/auth.js";

import healthRoutes from "./routes/health.routes.js";
import testRoutes from "./routes/test.routes.js";
import { categoriesRouter, menuItemsRouter } from "./routes/menu.routes.js";
import notFound from "./middleware/notFound.js";
import errorHandler from "./middleware/errorHandler.js";

const app = express();

// Security middleware
app.use(helmet());

// CORS configuration
app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true,
  })
);

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

// 404 handler
app.use(notFound);

// Global error handler
app.use(errorHandler);

export default app;
