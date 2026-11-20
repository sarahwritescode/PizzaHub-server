
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";

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

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 6,
    maxPasswordLength: 128,
  },
});

export type Auth = typeof auth;
