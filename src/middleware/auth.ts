import type { NextFunction, Request, RequestHandler, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";

import { ALLOWED_ORIGINS } from "../config/env.js";
import { auth } from "../lib/auth.js";
import { JwtVerificationError, verifyAccessToken } from "../lib/jwt.js";

export type Role = "admin" | "vendor" | "customer";

/** The only user data the API layer works with. Always read from the database. */
export interface AuthUser {
  id: string;
  email: string;
  role: string;
  isBlocked: boolean;
}

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth / requireRole. `method` is how the caller proved who they are. */
      auth?: { user: AuthUser; method: "jwt" | "session" };
    }
  }
}

type FailureCode =
  | "NO_CREDENTIALS"
  | "INVALID_TOKEN"
  | "TOKEN_EXPIRED"
  | "ACCOUNT_BLOCKED"
  | "FORBIDDEN"
  | "ORIGIN_NOT_ALLOWED";

const fail = (
  res: Response,
  status: 401 | 403,
  code: FailureCode,
  message: string
) => {
  if (status === 401) {
    res.set("WWW-Authenticate", 'Bearer realm="pizzahub-api"');
  }

  return res.status(status).json({ success: false, code, message });
};

const toAuthUser = (user: {
  id: unknown;
  email: unknown;
  role?: unknown;
  isBlocked?: unknown;
}): AuthUser => ({
  id: String(user.id),
  email: String(user.email),
  role: typeof user.role === "string" ? user.role : "",
  isBlocked: user.isBlocked === true,
});

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Authentication: who is calling? Never authorization.
 *
 * Two ways to prove identity, both verified by Better Auth, never by trusting
 * anything the client says about itself (user id, role and isBlocked in headers
 * or body are ignored):
 *
 *  1. `Authorization: Bearer <JWT>`  The JWT from GET /api/auth/token. Its
 *     signature, expiry, issuer, audience and algorithm are verified, then the
 *     user is loaded from the database using the verified `sub`.
 *  2. The Better Auth session cookie (used by the browser frontend).
 *
 * If an Authorization header is present it is the only thing considered: a bad
 * token is a 401, it does not fall back to a cookie.
 *
 * 401: no / invalid / expired credentials.   403: the account is blocked.
 * On success `req.auth.user` holds the user as stored in the database right now.
 */
export const requireAuth: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authorization = req.headers.authorization;
    let user: AuthUser;
    let method: "jwt" | "session";

    if (authorization !== undefined) {
      const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];

      if (!token) {
        return fail(res, 401, "INVALID_TOKEN", "Invalid authorization header.");
      }

      let userId: string;

      try {
        userId = (await verifyAccessToken(token)).sub;
      } catch (error) {
        if (error instanceof JwtVerificationError) {
          return error.reason === "expired"
            ? fail(res, 401, "TOKEN_EXPIRED", "Token has expired.")
            : fail(res, 401, "INVALID_TOKEN", "Invalid token.");
        }

        throw error;
      }

      // Authorization data is read fresh, never from the token: a token is
      // valid for minutes, but a user can be blocked or demoted at any time.
      const context = await auth.$context;
      const dbUser = await context.internalAdapter.findUserById(userId);

      if (!dbUser) {
        return fail(res, 401, "INVALID_TOKEN", "Invalid token.");
      }

      user = toAuthUser(dbUser);
      method = "jwt";
    } else {
      // Cookies are sent by the browser on its own, so a cookie-authenticated
      // request that changes data must come from our own frontend. Browsers
      // always send `Origin` on such requests; non-browser clients (Postman,
      // curl) do not, and are not CSRF vectors.
      const origin = req.headers.origin;

      if (!SAFE_METHODS.has(req.method) && origin && !ALLOWED_ORIGINS.includes(origin)) {
        return fail(res, 403, "ORIGIN_NOT_ALLOWED", "Origin not allowed.");
      }

      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });

      if (!session) {
        return fail(res, 401, "NO_CREDENTIALS", "Authentication required.");
      }

      user = toAuthUser(session.user);
      method = "session";
    }

    // Checked on every request, so blocking a user also cuts off tokens and
    // sessions that were issued before they were blocked.
    if (user.isBlocked) {
      return fail(res, 403, "ACCOUNT_BLOCKED", "Your account has been blocked.");
    }

    req.auth = { user, method };
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Authorization: is this caller allowed to do this? Includes requireAuth, so a
 * route only needs this one:
 *   router.get("/", requireRole("admin"), handler)
 *   router.post("/", requireRole("vendor", "admin"), handler)
 *   router.get("/me", requireAuth, handler)   // any logged-in, non-blocked user
 */
export const requireRole = (...roles: Role[]): RequestHandler[] => [
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    const role = req.auth?.user.role;

    if (!role || !(roles as string[]).includes(role)) {
      return fail(res, 403, "FORBIDDEN", "You do not have permission to do this.");
    }

    next();
  },
];
