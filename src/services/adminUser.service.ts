import type { ObjectId, Filter } from "mongodb";

import { auth } from "../lib/auth.js";
import { usersCollection, type UserDoc } from "../models/index.js";
import { HttpError } from "../utils/httpError.js";
import { buildPagination } from "../utils/pagination.js";
import type { AdminUsersQuery } from "../validations/admin.validation.js";
import { escapeRegex } from "./menu.service.js";
import { hasPremium } from "./vendorMenu.service.js";

// ───────────────────────── response shape ─────────────────────────

/**
 * Allow-list: ONLY these fields are ever read from `users`. Passwords live in Better Auth's
 * `account` collection and sessions in `session`, neither is touched here; the Stripe ids
 * stored on the user are not needed by an admin and stay out as well.
 */
const USER_PROJECTION = {
  name: 1,
  email: 1,
  role: 1,
  image: 1,
  businessName: 1,
  isBlocked: 1,
  subscriptionPlan: 1,
  subscriptionExpiresAt: 1,
  createdAt: 1,
} as const;

export type AdminUserView = Pick<
  UserDoc,
  "_id" | "name" | "email" | "role" | "isBlocked" | "createdAt"
> & {
  image: string | null;
  businessName: string | null;
  /** The EFFECTIVE plan, as in GET /api/vendor/subscription: premium only while the paid period has not run out. */
  subscriptionPlan: "free" | "premium";
  subscriptionExpiresAt: Date | null;
};

type StoredUser = Pick<UserDoc, "_id" | "name" | "email" | "role" | "isBlocked" | "createdAt"> &
  Partial<Pick<UserDoc, "image" | "businessName" | "subscriptionPlan" | "subscriptionExpiresAt">>;

const toUserView = (user: StoredUser): AdminUserView => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  image: user.image ?? null,
  businessName: user.businessName ?? null,
  isBlocked: user.isBlocked === true,
  subscriptionPlan: hasPremium({
    subscriptionPlan: user.subscriptionPlan ?? "free",
    subscriptionExpiresAt: user.subscriptionExpiresAt,
  })
    ? "premium"
    : "free",
  subscriptionExpiresAt: user.subscriptionExpiresAt ?? null,
  createdAt: user.createdAt,
});

const userNotFound = () => new HttpError(404, "User not found", "USER_NOT_FOUND");

const findStoredUser = (id: ObjectId) =>
  usersCollection().findOne({ _id: id }, { projection: USER_PROJECTION }) as Promise<StoredUser | null>;

// ───────────────────────── list / details ─────────────────────────

const buildListFilter = ({ search, role, status }: AdminUsersQuery): Filter<UserDoc> => {
  const filter: Filter<UserDoc> = {};

  if (role) filter.role = role;

  // "unblocked" also matches a user that has no isBlocked field at all.
  if (status === "blocked") filter.isBlocked = true;
  if (status === "unblocked") filter.isBlocked = { $ne: true };

  // Partial match ignoring case, on the name or the email.
  if (search) {
    const pattern = { $regex: escapeRegex(search), $options: "i" };
    filter.$or = [{ name: pattern }, { email: pattern }];
  }

  return filter;
};

/** GET /api/admin/users: newest first. */
export const listUsers = async (query: AdminUsersQuery) => {
  const { page, limit } = query;
  const filter = buildListFilter(query);
  const collection = usersCollection();

  const [users, totalItems] = await Promise.all([
    collection
      .find(filter)
      .project<StoredUser>(USER_PROJECTION)
      // _id as tie-breaker: equal createdAt values must not swap places between pages.
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    collection.countDocuments(filter),
  ]);

  return { items: users.map(toUserView), pagination: buildPagination(page, limit, totalItems) };
};

/** GET /api/admin/users/:id */
export const getUser = async (id: ObjectId): Promise<AdminUserView> => {
  const user = await findStoredUser(id);
  if (!user) throw userNotFound();

  return toUserView(user);
};

// ───────────────────────── block / unblock ─────────────────────────

/**
 * Block and unblock share this one function so the rules cannot drift apart.
 *
 * Who can be blocked:
 *   - not yourself (an admin who blocks themselves is locked out of the admin API)
 *   - not any admin. Admin accounts are created only by `npm run seed:admin`, there is no
 *     endpoint that can promote or restore one, so an admin blocking an admin could never be
 *     undone through the API and a single mistake (or a stolen admin token) could lock
 *     every admin out. A block on an admin can only be a database-level decision.
 *   - customers and vendors: yes.
 * Unblocking has no such limit (it only gives access back).
 *
 * Blocking sets isBlocked and deletes the user's Better Auth sessions. Nothing else is touched:
 * the user's menu items, orders and transactions stay exactly as they are. The block takes
 * effect on the very next request anyway (requireAuth reads isBlocked from the database on every
 * request, so tokens and cookies issued earlier stop working), and a blocked user cannot sign in.
 *
 * The write only matches while the user still has the opposite state: two admins acting at the
 * same moment cannot both "succeed".
 */
export const setUserBlocked = async (adminId: string, userId: ObjectId, blocked: boolean): Promise<AdminUserView> => {
  const user = await findStoredUser(userId);
  if (!user) throw userNotFound();

  if (blocked) {
    if (userId.toHexString() === adminId) {
      throw new HttpError(403, "You cannot block your own account.", "CANNOT_BLOCK_SELF");
    }

    if (user.role === "admin") {
      throw new HttpError(403, "An admin account cannot be blocked.", "CANNOT_BLOCK_ADMIN");
    }
  }

  const alreadyDone = () =>
    new HttpError(
      409,
      blocked ? "This user is already blocked." : "This user is not blocked.",
      blocked ? "ALREADY_BLOCKED" : "ALREADY_UNBLOCKED"
    );

  if ((user.isBlocked === true) === blocked) throw alreadyDone();

  const { matchedCount } = await usersCollection().updateOne(
    { _id: userId, isBlocked: blocked ? { $ne: true } : true },
    { $set: { isBlocked: blocked, updatedAt: new Date() } }
  );

  if (matchedCount === 0) throw alreadyDone();

  if (blocked) {
    try {
      await (await auth.$context).internalAdapter.deleteUserSessions(userId.toHexString());
    } catch {
      // The block already holds (requireAuth refuses a blocked user on every request), so a
      // failure here only leaves unusable session rows behind. Only the fact is logged.
      console.error("[admin] user was blocked but their sessions could not be deleted");
    }
  }

  const updated = await findStoredUser(userId);
  if (!updated) throw userNotFound();

  return toUserView(updated);
};
