


import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { createAuthMiddleware, APIError } from "better-auth/api";

import { client } from "../config/db.js";
import { env } from "../config/env.js";

export const auth = betterAuth({
  appName: "PizzaHub",

  baseURL: env.BETTER_AUTH_URL,

  secret: env.BETTER_AUTH_SECRET,

  database: mongodbAdapter(client.db(env.DB_NAME), {
    client,
  }),

  trustedOrigins: [env.CLIENT_URL],

  // User information and custom fields
  user: {
    modelName: "users",

    additionalFields: {
      role: {
        type: ["customer", "vendor"],
        required: false,
        defaultValue: "customer",
        input: true,
      },

      isBlocked: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
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

  // Password validation
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email") {
        const password = ctx.body?.password;

        if (typeof password === "string") {
          const hasUppercase = /[A-Z]/.test(password);
          const hasLowercase = /[a-z]/.test(password);

          if (!hasUppercase || !hasLowercase) {
            throw new APIError("BAD_REQUEST", {
              message:
                "Password must contain at least one uppercase and one lowercase letter.",
            });
          }
        }
      }
    }),
  },
});

export type Auth = typeof auth;
