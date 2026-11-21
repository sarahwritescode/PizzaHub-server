import type { NextFunction, Request, RequestHandler, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";

import { auth, type Auth } from "../lib/auth.js";

export type Role = "admin" | "vendor" | "customer";

type AuthSession = Auth["$Infer"]["Session"];

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth / requireRole. */
      auth?: AuthSession;
    }
  }
}

const fail = (res: Response, status: 401 | 403, message: string) =>
  res.status(status).json({ success: false, message });

/**
 * 401 when there is no valid session, 403 when the account is blocked.
 * On success the session is available as `req.auth` (`req.auth.user.role`, ...).
 */
export const requireAuth: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session) {
      return fail(res, 401, "Authentication required.");
    }

    // Checked on every request, so blocking a user also cuts off sessions
    // that were created before they were blocked.
    if (session.user.isBlocked) {
      return fail(res, 403, "Your account has been blocked.");
    }

    req.auth = session;
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Includes requireAuth, so a route only needs this one:
 *   router.get("/", requireRole("admin"), handler)
 *   router.post("/", requireRole("vendor", "admin"), handler)
 *   router.get("/me", requireAuth, handler)   // any logged-in, non-blocked user
 */
export const requireRole = (...roles: Role[]): RequestHandler[] => [
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    const role = req.auth?.user.role as Role | undefined;

    if (!role || !roles.includes(role)) {
      return fail(res, 403, "You do not have permission to do this.");
    }

    next();
  },
];
