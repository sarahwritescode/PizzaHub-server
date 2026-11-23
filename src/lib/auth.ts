import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";

import { client } from "../config/db.js";
import { ALLOWED_ORIGINS, env } from "../config/env.js";

const isProduction = env.NODE_ENV === "production";

// JWT settings shared by the signer (Better Auth jwt plugin, below) and the
// verifier (src/lib/jwt.ts), so the two can never drift apart.
export const JWT_ISSUER = env.BETTER_AUTH_URL;
export const JWT_AUDIENCE = env.BETTER_AUTH_URL;
export const JWT_ALG = "EdDSA" as const;

// Roles anyone may pick through the public API. "admin" is deliberately
// missing: admins are created only by the seed script (npm run seed:admin).
const PUBLIC_ROLES = ["customer", "vendor"] as const;

const isPublicRole = (role: unknown): boolean =>
  typeof role === "string" && (PUBLIC_ROLES as readonly string[]).includes(role);

// The only body fields POST /api/auth/update-user accepts.
const UPDATE_USER_ALLOWED_FIELDS: readonly string[] = ["name", "image", "businessName"];

// Password rule: min length is enforced by better-auth (minPasswordLength),
// this adds one uppercase + one lowercase letter.
const assertPasswordStrength = (password: unknown) => {
  if (typeof password !== "string") return;

  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password)) {
    throw new APIError("BAD_REQUEST", {
      message:
        "Password must contain at least one uppercase and one lowercase letter.",
    });
  }
};

// Endpoint path -> name of the body field that carries the new password.
const PASSWORD_FIELD_BY_PATH: Record<string, string> = {
  "/sign-up/email": "password",
  "/change-password": "newPassword",
  "/reset-password": "newPassword",
  "/set-password": "newPassword",
};

export const auth = betterAuth({
  appName: "PizzaHub",

  baseURL: env.BETTER_AUTH_URL,

  secret: env.BETTER_AUTH_SECRET,

  database: mongodbAdapter(client.db(env.DB_NAME), {
    client,
  }),

  trustedOrigins: [...ALLOWED_ORIGINS],

  // Cross-domain cookies in production (frontend and API on different domains).
  // `sameSite: "none"` requires `secure: true`, which only works over HTTPS,
  // so local http://localhost development keeps better-auth's defaults.
  advanced: {
    defaultCookieAttributes: isProduction
      ? { sameSite: "none", secure: true }
      : {},
  },

  // User information and custom fields
  user: {
    modelName: "users",

    additionalFields: {
      // "admin" is part of the type, but is never accepted from the public API
      // (see hooks.before and databaseHooks.user below).
      role: {
        type: ["admin", "customer", "vendor"],
        required: false,
        defaultValue: "customer",
        input: true,
        returned: true,
      },

      isBlocked: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
        returned: true,
      },

      businessName: {
        type: "string",
        required: false,
        input: true,
      },

      subscriptionPlan: {
        type: ["free", "premium"],
        required: false,
        defaultValue: "free",
        input: false,
      },

      subscriptionExpiresAt: {
        type: "date",
        required: false,
        input: false,
      },
    },
  },

  // Email and password authentication
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 6,
    maxPasswordLength: 128,
  },

  // Google login. New Google users get the default role ("customer").
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
  },

  // Access JWTs for the Express API.
  //  - GET /api/auth/token  (needs a signed-in session) returns a short-lived JWT
  //  - GET /api/auth/jwks   publishes the public keys used to verify it
  // The private signing keys live encrypted (with BETTER_AUTH_SECRET) in the
  // `jwks` collection. The Express side verifies the signature in src/lib/jwt.ts.
  plugins: [
    jwt({
      jwks: {
        keyPairConfig: { alg: JWT_ALG, crv: "Ed25519" },
      },
      jwt: {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expirationTime: env.JWT_EXPIRES_IN,
        // Keep the token small: `sub` (user id, added by Better Auth) is the only
        // thing the server relies on. Role and isBlocked are never read from the
        // token, they are loaded fresh from the database on every request.
        definePayload: ({ user }) => ({ email: user.email }),
      },
    }),
  ],

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      const body = ctx.body as Record<string, unknown> | undefined;

      // 1a) Sign-up: the role is picked once, and only "customer" or "vendor" (never admin).
      if (ctx.path === "/sign-up/email") {
        if (body?.role !== undefined && !isPublicRole(body.role)) {
          throw new APIError("BAD_REQUEST", {
            message: 'Role must be either "customer" or "vendor".',
          });
        }
      }

      // 1b) Update profile: a role can never be changed through the API, whatever the value
      // (even the user's current one: the key alone is refused). Only an allow-list of fields
      // is accepted, so email, isBlocked, subscription* and stripe* can never be written here.
      // Checked before anything is saved, so a refused request changes nothing.
      if (ctx.path === "/update-user" && body && typeof body === "object" && !Array.isArray(body)) {
        if (Object.hasOwn(body, "role")) {
          throw new APIError("BAD_REQUEST", { message: "Role cannot be changed." });
        }

        if (Object.keys(body).some((key) => !UPDATE_USER_ALLOWED_FIELDS.includes(key))) {
          throw new APIError("BAD_REQUEST", {
            message: "Only name, image and businessName can be updated.",
          });
        }
      }

      // Google sign-up can carry extra user fields in `additionalData`.
      if (ctx.path === "/sign-in/social") {
        const additionalData = body?.additionalData as
          | Record<string, unknown>
          | undefined;

        if (
          additionalData?.role !== undefined &&
          !isPublicRole(additionalData.role)
        ) {
          throw new APIError("BAD_REQUEST", {
            message: 'Role must be either "customer" or "vendor".',
          });
        }
      }

      // 2) Password rules on every endpoint that sets a password.
      const passwordField = PASSWORD_FIELD_BY_PATH[ctx.path];

      if (passwordField) {
        assertPasswordStrength(body?.[passwordField]);
      }
    }),
  },

  databaseHooks: {
    user: {
      // Safety net for every way a user can be created (email, Google, ...):
      // an unknown or "admin" role silently falls back to "customer".
      create: {
        before: async (user) => {
          return {
            data: {
              ...user,
              // Stored as null (not missing) until the vendor subscribes.
              subscriptionExpiresAt: user.subscriptionExpiresAt ?? null,
              ...(user.role !== undefined && !isPublicRole(user.role)
                ? { role: "customer" }
                : {}),
            },
          };
        },
      },

      // Nobody can be promoted to admin through an update either.
      update: {
        before: async (user) => {
          if (user.role !== undefined && !isPublicRole(user.role)) {
            throw new APIError("BAD_REQUEST", {
              message: 'Role must be either "customer" or "vendor".',
            });
          }
        },
      },
    },

    session: {
      // Runs for email sign-in and for the Google callback: blocked users
      // never get a session.
      create: {
        before: async (session, ctx) => {
          const user = await ctx?.context.internalAdapter.findUserById(
            session.userId
          );

          if (user && (user as { isBlocked?: boolean }).isBlocked) {
            throw new APIError("FORBIDDEN", {
              message: "Your account has been blocked.",
            });
          }
        },
      },
    },
  },
});

export type Auth = typeof auth;
