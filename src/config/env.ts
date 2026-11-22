
import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  CLIENT_URL: z.string().url(),

  // Optional extra browser origins that may call this API, comma separated
  // (e.g. "http://localhost:3000" so a local frontend can use the deployed API).
  // Each entry must be an exact http(s) origin: no "*", no wildcard hosts.
  // Entries are normalised with new URL(x).origin (paths / trailing slash dropped).
  EXTRA_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const origins: string[] = [];

      for (const entry of (raw ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
        let origin: string | undefined;

        try {
          const url = new URL(entry);
          if ((url.protocol === "http:" || url.protocol === "https:") && !entry.includes("*")) {
            origin = url.origin;
          }
        } catch {
          // falls through to the error below
        }

        if (!origin) {
          ctx.addIssue({
            code: "custom",
            message: `"${entry}" is not a valid origin. Use an exact http(s) URL such as http://localhost:3000 (no "*").`,
          });
          return z.NEVER;
        }

        origins.push(origin);
      }

      return origins;
    }),

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

/**
 * Every browser origin allowed to call this API: the primary frontend
 * (CLIENT_URL) plus EXTRA_ALLOWED_ORIGINS. One list, used by CORS, by Better
 * Auth's trustedOrigins and by the cookie-auth origin (CSRF) check, so the
 * three can never disagree.
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  ...new Set([new URL(env.CLIENT_URL).origin, ...env.EXTRA_ALLOWED_ORIGINS]),
];
