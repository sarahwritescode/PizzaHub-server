import type { Request, Response } from "express";
import Stripe from "stripe";

import { env } from "../config/env.js";
import { handleStripeEvent } from "../services/stripeWebhook.service.js";
import { HttpError } from "../utils/httpError.js";

/**
 * POST /api/stripe/webhook. Public (Stripe is not logged in), so the ONLY thing that lets a request
 * in is Stripe's signature, checked against the RAW body. This handler is mounted in app.ts with
 * express.raw() BEFORE express.json(): a parsed body would no longer match the signature.
 *
 * 400 for a missing/invalid signature or a body that is not raw (nothing is processed),
 * 503 when STRIPE_WEBHOOK_SECRET is not set, 500 when handling failed (Stripe retries), 200 otherwise.
 * An event type we did not subscribe to is acknowledged with 200 and ignored.
 */
export const stripeWebhook = async (req: Request, res: Response) => {
  const secret = env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    throw new HttpError(503, "Payments are not configured on the server.", "STRIPE_NOT_CONFIGURED");
  }

  const signature = req.headers["stripe-signature"];

  if (typeof signature !== "string" || signature === "") {
    throw new HttpError(400, "Missing Stripe signature.", "INVALID_SIGNATURE");
  }

  if (!Buffer.isBuffer(req.body)) {
    // Something parsed the body before this route (a misconfigured proxy or middleware order).
    console.error("[stripe] webhook body is not the raw request body: signature cannot be checked");
    throw new HttpError(400, "The webhook body must be the raw request body.", "INVALID_PAYLOAD");
  }

  let event: Stripe.Event;

  try {
    event = Stripe.webhooks.constructEvent(req.body, signature, secret);
  } catch {
    throw new HttpError(400, "Invalid Stripe signature.", "INVALID_SIGNATURE");
  }

  try {
    await handleStripeEvent(event);
  } catch (error) {
    // 500 makes Stripe retry later. Only the event and the kind of failure are logged: a Stripe or
    // database error object can be large and is not needed to find the problem.
    const kind = error instanceof Error ? error.name : "unknown";
    console.error(`[stripe] handling ${event.type} ${event.id} failed (${kind}): Stripe will retry`);
    throw new HttpError(500, "Webhook handling failed", "WEBHOOK_HANDLING_FAILED");
  }

  res.status(200).json({ success: true, message: "Webhook received", data: { received: true } });
};
