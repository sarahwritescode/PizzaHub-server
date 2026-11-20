import express from "express";
import cors from "cors";
import helmet from "helmet";

import { env } from "./config/env.js";
import healthRoutes from "./routes/health.routes.js";


const app = express();

// Security headers
app.use(helmet());

// CORS configuration
app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true,
  })
);

// Body parsers
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.use("/api/health", healthRoutes);

