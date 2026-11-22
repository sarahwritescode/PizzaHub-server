import { ObjectId, type ClientSession, type TransactionOptions } from "mongodb";
import type Stripe from "stripe";

import { client } from "../config/db.js";
import { getStripe, idOf, toMajorUnits } from "../lib/stripe.js";
import {
  transactionsCollection,
  transactionSchema,
  usersCollection,
  type TransactionStatus,
  type UserDoc,
} from "../models/index.js";

/**
 * Everything the Stripe webhook does. It is only ever called with an event whose signature was
 * verified (see stripeWebhook.controller.ts).
 *
 * Why this is safe to run twice (Stripe retries, and may send an event more than once):
 *  - nothing here counts or appends. Every write sets an ABSOLUTE state (plan, status, a date that only
 *    moves forward), so the second delivery changes nothing.
 *  - a transaction is keyed by its Checkout Session id (unique index), so one session is one row.
 *  - the subscription is always re-read from Stripe, so a stale or out-of-order event cannot
 *    overwrite newer state.
 *  - the writes of one event happen in one MongoDB transaction: Premium and its transaction row
 *    change together or not at all. A failure answers 500 and Stripe retries.
 *
 * What each event means (kept apart on purpose):
 *   checkout.session.completed   the first payment succeeded (or is still pending): activate Premium
 *   invoice.paid                 a payment succeeded, the first or a renewal: extend the paid period
 *   invoice.payment_failed       a payment failed: record it, Premium is NOT switched off here
 *   customer.subscription.updated   the subscription changed (cancel at period end, status): follow it
 *   customer.subscription.deleted   the subscription ended: back to Free
 *   checkout.session.expired     the customer never paid: the pending transaction expires
 */

const TRANSACTION_OPTIONS: TransactionOptions = {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
};

const inTransaction = async <T>(work: (session: ClientSession) => Promise<T>): Promise<T> => {
  const session = client.startSession();

  try {
    return await session.withTransaction(() => work(session), TRANSACTION_OPTIONS);
  } finally {
    await session.endSession();
  }
};

/** Statuses after which a subscription no longer gives access. */
const ENDED_STATUSES = ["canceled", "incomplete_expired", "unpaid"];

/** A subscription in one of these never produced a paid period, so a new checkout may replace it. */
const REPLACEABLE_STATUSES = ["canceled", "incomplete", "incomplete_expired", "unpaid"];

export type EventOutcome = "handled" | "ignored";

const ignore = (event: Stripe.Event, reason: string): EventOutcome => {
  console.warn(`[stripe] ${event.type} ${event.id} ignored: ${reason}`);
  return "ignored";
};

const stripeId = (value: unknown) => idOf(value as string | { id: string } | null | undefined);

// ───────────────────────── helpers ─────────────────────────

/**
 * Which vendor does this subscription belong to? Only the vendorId we put into the subscription's
 * metadata when WE created the checkout counts, and only for the Premium plan; the user must exist
 * and, if they already have a Stripe customer, it must be the same one. Anything else is not trusted.
 */
const resolveVendor = async (subscription: Stripe.Subscription, session?: ClientSession): Promise<UserDoc | null> => {
  const { vendorId, plan } = subscription.metadata ?? {};

  if (plan !== "premium" || !vendorId || !/^[0-9a-f]{24}$/i.test(vendorId)) return null;

  const user = await usersCollection().findOne({ _id: new ObjectId(vendorId) }, { session });
  if (!user) return null;

  const customerId = stripeId(subscription.customer);
  if (!customerId || (user.stripeCustomerId && user.stripeCustomerId !== customerId)) return null;

  return user;
};

/** The end of the period a subscription is currently paid for (Stripe keeps it on the items). */
const periodEnd = (subscription: Stripe.Subscription) => {
  const ends = subscription.items.data.map((item) => item.current_period_end).filter((end) => Number.isFinite(end));
  return ends.length ? new Date(Math.max(...ends) * 1000) : null;
};

/**
 * Premium on, until the end of the PAID period. The date only ever moves forward ($max), so a late
 * or repeated event cannot shorten it. A second subscription for a vendor who already has a
 * different live one is NOT linked (returns false): the caller cancels it.
 */
const activate = async (
  session: ClientSession,
  user: UserDoc,
  subscription: Stripe.Subscription,
  paidUntil: Date
): Promise<boolean> => {
  const { matchedCount } = await usersCollection().updateOne(
    {
      _id: user._id,
      $or: [
        { stripeSubscriptionId: { $exists: false } },
        { stripeSubscriptionId: null },
        { stripeSubscriptionId: subscription.id },
        { subscriptionStatus: { $in: REPLACEABLE_STATUSES } },
      ],
    },
    {
      $set: {
        subscriptionPlan: "premium",
        stripeCustomerId: stripeId(subscription.customer)!,
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        subscriptionCancelAtPeriodEnd: subscription.cancel_at_period_end === true,
        updatedAt: new Date(),
      },
      $max: { subscriptionExpiresAt: paidUntil },
    },
    { session }
  );

  return matchedCount === 1;
};

/** Back to Free. Only for the subscription the vendor currently has, so an old one ending changes nothing. */
const deactivate = async (session: ClientSession, user: UserDoc, subscription: Stripe.Subscription) => {
  const endedAt = new Date((subscription.ended_at ?? Math.floor(Date.now() / 1000)) * 1000);

  await usersCollection().updateOne(
    { _id: user._id, stripeSubscriptionId: subscription.id },
    [
      {
        $set: {
          subscriptionPlan: "free",
          subscriptionStatus: subscription.status === "canceled" ? "canceled" : subscription.status,
          subscriptionCancelAtPeriodEnd: false,
          // The paid access ends now at the latest; it never moves later.
          subscriptionExpiresAt: { $min: [{ $ifNull: ["$subscriptionExpiresAt", endedAt] }, endedAt] },
          updatedAt: "$$NOW",
        },
      },
    ],
    { session }
  );
};

/** Moves a transaction along. `from` limits what it may change, so a finished one is never rewritten. */
const recordTransaction = async (
  session: ClientSession,
  data: {
    vendorId: ObjectId;
    sessionId: string;
    subscriptionId: string | null;
    amount: number | null;
    currency: string | null;
    status: TransactionStatus;
    from: TransactionStatus[];
  }
) => {
  const transactions = transactionsCollection();

  if (data.amount !== null && data.currency) {
    // Creates the row if checkout did not (a unique index makes this one row per Checkout Session).
    const doc = transactionSchema.parse({
      vendorId: data.vendorId,
      plan: "premium",
      amount: data.amount,
      currency: data.currency,
      stripeSessionId: data.sessionId,
    });

    await transactions.updateOne({ stripeSessionId: data.sessionId }, { $setOnInsert: doc }, { upsert: true, session });
  }

  const set: Record<string, unknown> = { status: data.status };
  if (data.subscriptionId) set.stripeSubscriptionId = data.subscriptionId;
  if (data.amount !== null) set.amount = data.amount;
  if (data.currency) set.currency = data.currency;

  await transactions.updateOne(
    { stripeSessionId: data.sessionId, vendorId: data.vendorId, status: { $in: data.from } },
    { $set: set },
    { session }
  );
};

// ───────────────────────── events ─────────────────────────

const onCheckoutCompleted = async (event: Stripe.Event, checkout: Stripe.Checkout.Session): Promise<EventOutcome> => {
  const subscriptionId = stripeId(checkout.subscription);
  const customerId = stripeId(checkout.customer);

  if (checkout.mode !== "subscription" || !subscriptionId || !customerId) {
    return ignore(event, "not a subscription checkout");
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const user = await resolveVendor(subscription);

  if (!user || checkout.client_reference_id !== String(user._id) || checkout.metadata?.vendorId !== String(user._id)) {
    return ignore(event, "the checkout does not match a vendor we created it for");
  }

  const amount = toMajorUnits(checkout.amount_total, checkout.currency);
  const currency = checkout.currency?.toLowerCase() ?? null;

  if (checkout.payment_status !== "paid") {
    // Not paid yet (a delayed payment method): keep the row pending. invoice.paid activates later.
    await inTransaction((session) =>
      recordTransaction(session, { vendorId: user._id, sessionId: checkout.id, subscriptionId, amount, currency, status: "pending", from: ["pending"] })
    );
    return "handled";
  }

  const paidUntil = periodEnd(subscription);

  if (amount === null || !currency || !paidUntil) {
    return ignore(event, "paid session without a usable amount, currency or period: not activating Premium");
  }

  const linked = await inTransaction(async (session) => {
    const linkedNow = await activate(session, user, subscription, paidUntil);

    await recordTransaction(session, {
      vendorId: user._id,
      sessionId: checkout.id,
      subscriptionId,
      amount,
      currency,
      // A second paid subscription for a vendor who already has one is not Premium twice.
      status: linkedNow ? "success" : "cancelled",
      from: ["pending", "failed"],
    });

    return linkedNow;
  });

  if (!linked) {
    console.error(
      `[stripe] vendor ${user._id} paid for a second subscription (${subscriptionId}). It is being cancelled; ` +
        "the payment must be refunded by hand in the Stripe Dashboard."
    );

    if (subscription.status !== "canceled") await stripe.subscriptions.cancel(subscriptionId);
  }

  return "handled";
};

const onCheckoutExpired = async (event: Stripe.Event, checkout: Stripe.Checkout.Session): Promise<EventOutcome> => {
  const vendorId = checkout.metadata?.vendorId;
  if (checkout.mode !== "subscription" || !vendorId || !/^[0-9a-f]{24}$/i.test(vendorId)) {
    return ignore(event, "not a subscription checkout of ours");
  }

  await transactionsCollection().updateOne(
    { stripeSessionId: checkout.id, vendorId: new ObjectId(vendorId), status: "pending" },
    { $set: { status: "expired" } }
  );
  return "handled";
};

const subscriptionIdOfInvoice = (invoice: Stripe.Invoice) =>
  stripeId(invoice.parent?.subscription_details?.subscription as string | { id: string } | null | undefined);

const onInvoicePaid = async (event: Stripe.Event, invoice: Stripe.Invoice): Promise<EventOutcome> => {
  const subscriptionId = subscriptionIdOfInvoice(invoice);

  if (!subscriptionId) return ignore(event, "invoice without a subscription");
  if (!(invoice.amount_paid > 0)) return ignore(event, "nothing was paid on this invoice");

  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  const user = await resolveVendor(subscription);
  if (!user) return ignore(event, "the subscription does not belong to a vendor we created it for");

  // The period this invoice paid for. A renewal moves it forward; the same invoice again changes nothing.
  const ends = invoice.lines.data.map((line) => line.period?.end).filter((end): end is number => Number.isFinite(end));
  if (!ends.length) return ignore(event, "invoice without a period");

  const linked = await inTransaction((session) => activate(session, user, subscription, new Date(Math.max(...ends) * 1000)));
  return linked ? "handled" : ignore(event, "the vendor has a different live subscription");
};

const onInvoicePaymentFailed = async (event: Stripe.Event, invoice: Stripe.Invoice): Promise<EventOutcome> => {
  const subscriptionId = subscriptionIdOfInvoice(invoice);
  if (!subscriptionId) return ignore(event, "invoice without a subscription");

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const user = await resolveVendor(subscription);
  if (!user) return ignore(event, "the subscription does not belong to a vendor we created it for");

  // The first payment failed: the checkout's transaction fails (it can still succeed if the customer retries).
  let checkoutId: string | null = null;

  if (invoice.billing_reason === "subscription_create") {
    const sessions = await stripe.checkout.sessions.list({ subscription: subscriptionId, limit: 1 });
    checkoutId = sessions.data[0]?.id ?? null;
  }

  await inTransaction(async (session) => {
    // Premium is NOT switched off by a failed payment: the vendor keeps what is already paid for until
    // the paid period ends or Stripe gives up and ends the subscription (customer.subscription.deleted).
    await usersCollection().updateOne(
      { _id: user._id, stripeSubscriptionId: subscription.id },
      { $set: { subscriptionStatus: subscription.status, updatedAt: new Date() } },
      { session }
    );

    if (checkoutId) {
      await recordTransaction(session, {
        vendorId: user._id,
        sessionId: checkoutId,
        subscriptionId,
        amount: toMajorUnits(invoice.amount_due, invoice.currency),
        currency: invoice.currency?.toLowerCase() ?? null,
        status: "failed",
        from: ["pending"],
      });
    }
  });

  return "handled";
};

const onSubscriptionChanged = async (event: Stripe.Event, changed: Stripe.Subscription): Promise<EventOutcome> => {
  // The event is a snapshot and may be old; what Stripe says now is what counts.
  const subscription = await getStripe().subscriptions.retrieve(changed.id);
  const user = await resolveVendor(subscription);

  if (!user || user.stripeSubscriptionId !== subscription.id) {
    return ignore(event, "not the current subscription of a vendor (yet)");
  }

  await inTransaction(async (session) => {
    if (ENDED_STATUSES.includes(subscription.status)) {
      await deactivate(session, user, subscription);
      return;
    }

    const paidUntil = subscription.status === "active" ? periodEnd(subscription) : null;

    await usersCollection().updateOne(
      { _id: user._id, stripeSubscriptionId: subscription.id },
      {
        $set: {
          subscriptionStatus: subscription.status,
          subscriptionCancelAtPeriodEnd: subscription.cancel_at_period_end === true,
          updatedAt: new Date(),
          // Only an ACTIVE subscription (its latest invoice is paid) extends access. past_due does not:
          // its new period is not paid yet.
          ...(paidUntil ? { subscriptionPlan: "premium" } : {}),
        },
        ...(paidUntil ? { $max: { subscriptionExpiresAt: paidUntil } } : {}),
      },
      { session }
    );
  });

  return "handled";
};

const onSubscriptionDeleted = async (event: Stripe.Event, ended: Stripe.Subscription): Promise<EventOutcome> => {
  // The deleted event IS the final state: no need to ask Stripe.
  const user = await resolveVendor(ended);
  if (!user) return ignore(event, "the subscription does not belong to a vendor we created it for");

  await inTransaction(async (session) => {
    await deactivate(session, user, ended);

    // A checkout that never got paid and whose subscription is gone is over.
    await transactionsCollection().updateMany(
      { vendorId: user._id, stripeSubscriptionId: ended.id, status: "pending" },
      { $set: { status: ended.status === "incomplete_expired" ? "expired" : "cancelled" } },
      { session }
    );
  });

  return "handled";
};

export const handleStripeEvent = async (event: Stripe.Event): Promise<EventOutcome> => {
  switch (event.type) {
    case "checkout.session.completed":
      return onCheckoutCompleted(event, event.data.object);
    case "checkout.session.expired":
      return onCheckoutExpired(event, event.data.object);
    case "invoice.paid":
      return onInvoicePaid(event, event.data.object);
    case "invoice.payment_failed":
      return onInvoicePaymentFailed(event, event.data.object);
    case "customer.subscription.updated":
      return onSubscriptionChanged(event, event.data.object);
    case "customer.subscription.deleted":
      return onSubscriptionDeleted(event, event.data.object);
    default:
      return "ignored"; // an event type we did not ask for: acknowledged, nothing to do
  }
};
