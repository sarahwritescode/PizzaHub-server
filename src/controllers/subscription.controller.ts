import { ObjectId } from "mongodb";
import type { Request, Response } from "express";

import * as subscriptions from "../services/subscription.service.js";
import { parseWith } from "../utils/validate.js";
import { emptyBodySchema } from "../validations/order.validation.js";

// These handlers run behind requireRole("vendor"), so req.auth is always set.
// The vendor is the verified, database-loaded user: never a value from the request.
const vendorIdOf = (req: Request) => new ObjectId(req.auth!.user.id);

export const getSubscription = async (req: Request, res: Response) => {
  const subscription = await subscriptions.getVendorSubscription(vendorIdOf(req));

  res.status(200).json({ success: true, message: "Subscription fetched successfully", data: subscription });
};

export const createCheckout = async (req: Request, res: Response) => {
  // No body is read: a price, an amount, a currency or a plan from the client is refused, not ignored.
  parseWith(emptyBodySchema, req.body ?? {});
  const { url, sessionId, reused } = await subscriptions.startPremiumCheckout(vendorIdOf(req));

  res.status(reused ? 200 : 201).json({
    success: true,
    message: "Checkout session created. Redirect the vendor to the url to pay.",
    data: { url, sessionId },
  });
};
