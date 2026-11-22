import Stripe from "stripe";

import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

let client: Stripe | undefined;

/**
 * The one Stripe client. Throws 503 STRIPE_NOT_CONFIGURED when there is no secret key, so a
 * server without Stripe still starts and every other API works. The key is never logged or returned.
 */
export const getStripe = (): Stripe => {
  if (!env.STRIPE_SECRET_KEY) {
    throw new HttpError(503, "Payments are not configured on the server.", "STRIPE_NOT_CONFIGURED");
  }

  client ??= new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20_000 });
  return client;
};

/** The Premium Price id, or 503. Amount, currency and billing period are whatever that Price says. */
export const getPremiumPriceId = (): string => {
  if (!env.STRIPE_PREMIUM_PRICE_ID) {
    throw new HttpError(503, "Payments are not configured on the server.", "STRIPE_NOT_CONFIGURED");
  }

  return env.STRIPE_PREMIUM_PRICE_ID;
};

/** Test hook: lets `npm run verify:stripe` point the SDK at a local stand-in for Stripe. Not used by the app. */
export const overrideStripeClientForTests = (replacement: Stripe | undefined) => {
  client = replacement;
};

/**
 * Stripe amounts are integers in the currency's smallest unit (cents for usd, whole yen for jpy).
 * Stored amounts are in the normal unit (9.99), like menu prices. Returns null for anything that is
 * not a positive integer amount of a valid currency: such data is never trusted.
 */
export const toMajorUnits = (minor: number | null | undefined, currency: string | null | undefined) => {
  if (typeof minor !== "number" || !Number.isInteger(minor) || minor <= 0) return null;
  if (typeof currency !== "string" || currency.length !== 3) return null;

  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).resolvedOptions()
      .maximumFractionDigits ?? 2;

    return minor / 10 ** digits;
  } catch {
    return null; // not a currency code
  }
};

/** An expandable Stripe field (id string or object) to its id. */
export const idOf = (value: string | { id: string } | null | undefined): string | null =>
  typeof value === "string" ? value : value && typeof value.id === "string" ? value.id : null;
