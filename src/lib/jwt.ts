import {
  createLocalJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";

import { auth, JWT_ALG, JWT_AUDIENCE, JWT_ISSUER } from "./auth.js";

/**
 * Verifies the access JWT that Better Auth issues at GET /api/auth/token.
 *
 * What is checked (all of it, on every call):
 *  - the signature, against the public keys Better Auth publishes (JWKS)
 *  - the algorithm, pinned to JWT_ALG so "alg: none" / HS256 tokens are refused
 *  - exp (expiry), iss (issuer) and aud (audience)
 *  - that `sub` (the user id) is present
 *
 * Nothing is trusted before the signature has been verified; the token is
 * never just decoded.
 */

export class JwtVerificationError extends Error {
  constructor(public readonly reason: "expired" | "invalid") {
    super(reason === "expired" ? "Token expired" : "Token invalid");
  }
}

type KeySet = ReturnType<typeof createLocalJWKSet>;
type CachedKeySet = { resolve: KeySet; loadedAt: number };

// The public keys rarely change, so keep them for a few minutes instead of
// reading the database on every request.
const KEYSET_TTL_MS = 5 * 60_000;
// If a token names an unknown key id, reload the keys (it may be a freshly
// rotated key), but never more often than this: random key ids must not be
// able to turn every request into a database read.
const MIN_RELOAD_INTERVAL_MS = 10_000;

let cached: CachedKeySet | null = null;

const loadKeySet = async (): Promise<CachedKeySet> => {
  // Server-side call of the jwt plugin's JWKS endpoint (no HTTP round trip).
  const jwks = (await auth.api.getJwks()) as unknown as JSONWebKeySet;

  cached = { resolve: createLocalJWKSet(jwks), loadedAt: Date.now() };

  return cached;
};

const verifyWith = async (token: string, keySet: CachedKeySet) => {
  const { payload } = await jwtVerify(token, keySet.resolve, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: [JWT_ALG],
    requiredClaims: ["sub", "exp"],
  });

  return payload;
};

export const verifyAccessToken = async (
  token: string
): Promise<JWTPayload & { sub: string }> => {
  try {
    let keySet =
      cached && Date.now() - cached.loadedAt < KEYSET_TTL_MS
        ? cached
        : await loadKeySet();

    let payload: JWTPayload;

    try {
      payload = await verifyWith(token, keySet);
    } catch (error) {
      const canReload =
        error instanceof errors.JWKSNoMatchingKey &&
        Date.now() - keySet.loadedAt > MIN_RELOAD_INTERVAL_MS;

      if (!canReload) throw error;

      keySet = await loadKeySet();
      payload = await verifyWith(token, keySet);
    }

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new JwtVerificationError("invalid");
    }

    return payload as JWTPayload & { sub: string };
  } catch (error) {
    if (error instanceof JwtVerificationError) throw error;

    if (error instanceof errors.JWTExpired) {
      throw new JwtVerificationError("expired");
    }

    // Bad signature, wrong issuer/audience/algorithm, malformed token, unknown
    // key, ... all collapse into one answer so nothing leaks to the caller.
    if (error instanceof errors.JOSEError) {
      throw new JwtVerificationError("invalid");
    }

    // Anything else (for example the database being down) is a server problem,
    // not a bad token: let the error handler turn it into a 500.
    throw error;
  }
};
