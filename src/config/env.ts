
import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  CLIENT_URL: z.string().url(),

  MONGODB_URI: z.string().min(1),
  DB_NAME: z.string().min(1),


  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),

  // Lifetime of the access JWT issued by GET /api/auth/token (e.g. 15m, 1h).
  JWT_EXPIRES_IN: z
    .string()
    .regex(/^\d+[smhd]$/, 'Use a number plus s, m, h or d (e.g. "15m")')
    .default("15m"),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),

  // ImgBB API key for POST /api/vendor/upload-image (https://api.imgbb.com/).
  // Optional on purpose: without it the server still starts and every other
  // API works; only the upload endpoint answers 503 UPLOAD_NOT_CONFIGURED.
  // An empty value (the .env.example placeholder) counts as "not set".
  IMGBB_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("Invalid environment variables:");
  console.error(parsedEnv.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsedEnv.data;
