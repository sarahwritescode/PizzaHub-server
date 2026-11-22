import type { ObjectId } from "mongodb";
import type Stripe from "stripe";

import { env } from "../config/env.js";
import { getPremiumPriceId, getStripe, toMajorUnits } from "../lib/stripe.js";
import { transactionsCollection, transactionSchema, usersCollection, type UserDoc } from "../models/index.js";
import { HttpError } from "../utils/httpError.js";
import { hasPremium } from "./vendorMenu.service.js";

const DUPLICATE_KEY = 11000;

/** A Checkout Session stays open 24 hours; reuse one only while it is clearly still usable. */
const REUSE_WINDOW_MS = 23 * 60 * 60 * 1000;

/** Statuses of a Stripe subscription that is (or may still become) a live, billed subscription. */
const LIVE_STATUSES = ["active", "trialing", "past_due"];

// Where Stripe sends the customer afterwards. Both are on the frontend (CLIENT_URL); the success
// page does NOT activate anything, it only polls GET /api/vendor/subscription until the webhook has.
const clientRoute = (query: string) =>
  `${new URL(env.CLIENT_URL).origin}/dashboard/vendor/subscription?checkout=${query}`;

export const SUCCESS_URL = () => clientRoute("success");
export const CANCEL_URL = () => clientRoute("cancelled");

// ───────────────────────── read ─────────────────────────

/**
 * GET /api/vendor/subscription. Only what the vendor needs; no Stripe customer id, no keys, no
 * payment details. `subscriptionPlan` is the EFFECTIVE plan: premium only while the paid period
 * has not run out (the same rule the menu API uses), so it can never say "premium" for an expired plan.
 */
export const getVendorSubscription = async (vendorId: ObjectId) => {
  const user = await usersCollection().findOne({ _id: vendorId });
  if (!user) throw new HttpError(401, "Account not found", "INVALID_TOKEN");

  const isPremium = hasPremium(user);

  return {
    subscriptionPlan: isPremium ? ("premium" as const) : ("free" as const),
    isPremium,
    subscriptionStatus: user.subscriptionStatus ?? "none",
    subscriptionExpiresAt: user.subscriptionExpiresAt ?? null,
    cancelAtPeriodEnd: user.subscriptionCancelAtPeriodEnd === true,
    stripeSubscriptionId: user.stripeSubscriptionId ?? null,
  };
};

// ───────────────────────── checkout ─────────────────────────

const paymentServiceError = (error: unknown) => {
  // Only the kind of failure is logged: never the request, the key or the customer's data.
  const type = (error as { type?: string } | undefined)?.type ?? (error instanceof Error ? error.name : "unknown");
  console.error(`[stripe] request failed (${type})`);
  return new HttpError(502, "The payment service could not be reached. Please try again.", "PAYMENT_SERVICE_ERROR");
};

/** Reuses the vendor's Stripe customer, or creates one once and remembers it. */
const ensureCustomer = async (stripe: Stripe, user: UserDoc) => {
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await stripe.customers.create(
    { email: user.email, name: user.name, metadata: { vendorId: String(user._id) } },
    // Two requests at the same moment get the same customer, not two.
    { idempotencyKey: `premium-customer:${user._id}` }
  );

  const { modifiedCount } = await usersCollection().updateOne(
    { _id: user._id, $or: [{ stripeCustomerId: { $exists: false } }, { stripeCustomerId: null }] },
    { $set: { stripeCustomerId: customer.id } }
  );

  if (modifiedCount === 0) {
    // Another request stored one first: use that one.
    const latest = await usersCollection().findOne({ _id: user._id }, { projection: { stripeCustomerId: 1 } });
    return latest?.stripeCustomerId ?? customer.id;
  }

  return customer.id;
};

/** A still-open Checkout Session of this vendor, so a second click does not create a second one. */
const findOpenSession = async (stripe: Stripe, vendorId: ObjectId) => {
  const pending = await transactionsCollection()
    .find({ vendorId, status: "pending" })
    .sort({ createdAt: -1 })
    .limit(1)
    .next();

  if (!pending || Date.now() - pending.createdAt.getTime() > REUSE_WINDOW_MS) return null;

  try {
    const session = await stripe.checkout.sessions.retrieve(pending.stripeSessionId);
    return session.status === "open" && session.url ? session : null;
  } catch {
    return null; // cannot tell: make a fresh one
  }
};

/**
 * POST /api/vendor/subscription/checkout
 *
 * The caller, the price and the redirect URLs all come from the server: the request body is empty
 * (anything in it is refused before this runs). Nothing here activates Premium: that only happens
 * when the verified webhook says the payment succeeded.
 */
export const startPremiumCheckout = async (vendorId: ObjectId) => {
  const stripe = getStripe();
  const priceId = getPremiumPriceId();

  const user = await usersCollection().findOne({ _id: vendorId });
  if (!user) throw new HttpError(401, "Account not found", "INVALID_TOKEN");

  if (hasPremium(user)) {
    throw new HttpError(409, "You already have an active Premium subscription.", "ALREADY_PREMIUM");
  }

  // Paid period over (or not recorded yet) but Stripe still has a live subscription: another
  // checkout would bill the vendor twice.
  if (user.stripeSubscriptionId && LIVE_STATUSES.includes(user.subscriptionStatus ?? "")) {
    throw new HttpError(
      409,
      "You already have a Premium subscription with Stripe. If it was just paid, wait a moment and refresh.",
      "SUBSCRIPTION_EXISTS"
    );
  }

  try {
    // How many checkouts this vendor has started. Part of the idempotency key below: a double click
    // (same count) gets the same session, but a NEW attempt after the old one ended gets a new one.
    const attempt = await transactionsCollection().countDocuments({ vendorId });

    const open = await findOpenSession(stripe, vendorId);
    if (open) return { url: open.url!, sessionId: open.id, reused: true };

    const customer = await ensureCustomer(stripe, user);
    const vendor = String(vendorId);
    const metadata = { vendorId: vendor, plan: "premium" };

    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer,
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: vendor,
        metadata,
        // The subscription itself carries the vendor too, so every later event can be matched to them.
        subscription_data: { metadata },
        success_url: SUCCESS_URL(),
        cancel_url: CANCEL_URL(),
      },
      // A double click gives back the same session instead of two.
      { idempotencyKey: `premium-checkout:${vendor}:${attempt}:${Math.floor(Date.now() / 60_000)}` }
    );

    if (!session.url) throw new Error("Stripe returned a session without a url");

    // Recorded as "pending"; only the webhook can turn it into "success". A session whose amount is
    // not a positive amount cannot be stored (the collection refuses it): the webhook records it later.
    const amount = toMajorUnits(session.amount_total, session.currency);

    if (amount !== null && session.currency) {
      const transaction = transactionSchema.parse({
        vendorId,
        plan: "premium",
        amount,
        currency: session.currency,
        stripeSessionId: session.id,
      });

      try {
        await transactionsCollection().insertOne(transaction);
      } catch (error) {
        if ((error as { code?: number }).code !== DUPLICATE_KEY) throw error; // the same session, already stored
      }
    }

    return { url: session.url, sessionId: session.id, reused: false };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw paymentServiceError(error);
  }
};

