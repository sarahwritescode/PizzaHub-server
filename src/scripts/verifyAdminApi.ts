/**
 * Checks the admin management API end to end over real HTTP: `npm run verify:admin`.
 *
 * Real sign-up, real Better Auth JWTs, real MongoDB. It never touches your real data: DB_NAME is
 * switched to a throwaway database (pizzahub_admin_verify_<timestamp>) BEFORE the app is loaded,
 * and that database is dropped at the end.
 *
 * Users are created through the real sign-up; admins (sign-up cannot create one), the blocked flag,
 * premium state and the Stripe ids are set directly in the throwaway database, as in the other
 * verify scripts. Orders, menu items and transactions are inserted directly so every status exists.
 */
process.env.DB_NAME = `pizzahub_admin_verify_${Date.now()}`;

const { ObjectId } = await import("mongodb");
const { default: app } = await import("../app.js");
const { env } = await import("../config/env.js");
const { client, connectDB, getDB } = await import("../config/db.js");
const { initializeDatabase } = await import("../config/initDatabase.js");
const { menuItemsCollection, ordersCollection, transactionsCollection, usersCollection } = await import(
  "../models/index.js"
);

let passed = 0;
const failures: string[] = [];

const check = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? "" : `\n       got: ${JSON.stringify(detail)}`}`);
  }
};

const section = (title: string) => console.log(`\n${title}`);

// biome-ignore lint: test helper, responses are checked field by field below
type Json = any;
type Res = { status: number; body: Json };
type Id = InstanceType<typeof ObjectId>;

let baseUrl = "";
const PASSWORD = "Passw0rdOK";
const runId = Date.now();

const call = async (method: string, path: string, token?: string | null, body?: unknown): Promise<Res> => {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;

  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }

  const response = await fetch(baseUrl + path, { method, headers, body: payload });
  return { status: response.status, body: await response.json() };
};

interface TestUser {
  token: string;
  cookie: string;
  id: Id;
  email: string;
  name: string;
}

const makeUser = async (label: string, role: "customer" | "vendor", name = label): Promise<TestUser> => {
  const email = `${label}.${runId}@pizzahub.test`.toLowerCase();

  const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.CLIENT_URL },
    body: JSON.stringify({ name, email, password: PASSWORD, role }),
  });
  if (!signUp.ok) throw new Error(`sign-up of ${label} failed: ${signUp.status} ${await signUp.text()}`);

  const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const tokenRes = await fetch(`${baseUrl}/api/auth/token`, { headers: { cookie } });
  const { token } = (await tokenRes.json()) as { token: string };

  const user = await usersCollection().findOne({ email });
  return { token, cookie, id: user!._id, email, name };
};

const dbUser = (id: Id | string) => usersCollection().findOne({ _id: new ObjectId(String(id)) });

const seedTransaction = async (
  vendorId: Id,
  status: "pending" | "success" | "failed" | "cancelled" | "expired",
  n: number
) => {
  const { insertedId } = await transactionsCollection().insertOne({
    vendorId,
    plan: "premium",
    amount: 9.99,
    currency: "usd",
    stripeSessionId: `cs_test_admin_${runId}_${n}`,
    stripeSubscriptionId: status === "success" ? `sub_test_admin_${runId}_${n}` : null,
    status,
    createdAt: new Date(Date.UTC(2030, 0, 1) + n * 1000), // strictly increasing: "newest first" is checkable
  } as never);
  return insertedId;
};

const USERS = "/api/admin/users";
const TX = "/api/admin/transactions";
const DASH = "/api/admin/dashboard";
const ADMIN_CATEGORIES = "/api/admin/menu-items/categories";
const VENDORS = "/api/admin/vendors";

const SAFE_USER_FIELDS = "_id,businessName,createdAt,email,image,isBlocked,name,role,subscriptionExpiresAt,subscriptionPlan";
const keysOf = (o: Json) => Object.keys(o).sort().join(",");

// Anything that must never appear anywhere in an admin response.
const FORBIDDEN_TEXT = [
  "password",
  "passwordHash",
  "hash",
  "token",
  "secret",
  "salt",
  "cus_SECRET",
  "stripeCustomerId",
  "sk_test",
  "whsec_",
  "sessionToken",
  "refreshToken",
  "accessToken",
  "idToken",
];
const leaks = (body: Json) => {
  const text = JSON.stringify(body);
  return FORBIDDEN_TEXT.filter((word) => text.toLowerCase().includes(word.toLowerCase()));
};

const server = app.listen(0);

try {
  await connectDB();
  await initializeDatabase();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  section("Setting up real users (sign-up + JWT)");
  const [admin, admin2, blockedAdmin, vendorA, vendorB, customer, alice, victim] = await Promise.all([
    makeUser("admin", "customer"),
    makeUser("admin2", "customer"),
    makeUser("blockedAdmin", "customer"),
    makeUser("vendorA", "vendor", "Vendor Alpha"),
    makeUser("vendorB", "vendor", "Vendor Beta"),
    makeUser("customer", "customer", "Plain Customer"),
    makeUser("alice", "customer", "Alice Wonder"),
    makeUser("victim", "customer", "Victim User"),
  ]);
  await usersCollection().updateOne({ _id: admin.id }, { $set: { role: "admin" } });
  await usersCollection().updateOne({ _id: admin2.id }, { $set: { role: "admin" } });
  await usersCollection().updateOne({ _id: blockedAdmin.id }, { $set: { role: "admin", isBlocked: true } });
  await usersCollection().updateOne({ _id: vendorA.id }, { $set: { businessName: "Alpha Kitchen", image: "https://example.com/a.png" } });
  // Premium vendor with Stripe references the admin API must never show.
  await usersCollection().updateOne(
    { _id: vendorB.id },
    {
      $set: {
        subscriptionPlan: "premium",
        subscriptionExpiresAt: new Date(Date.now() + 30 * 86_400_000),
        stripeCustomerId: "cus_SECRET_vendorB",
        stripeSubscriptionId: "sub_vendorB",
        subscriptionStatus: "active",
      },
    }
  );
  check("8 users created with tokens", [admin, admin2, blockedAdmin, vendorA, vendorB, customer, alice, victim].every((u) => u.token.length > 20));

  // ------------------------------------------------------------ access control
  section("1. Access control: anonymous, customer, vendor, blocked admin (every endpoint)");
  {
    const fakeId = new ObjectId().toHexString();
    const probes: [string, string][] = [
      ["GET", DASH],
      ["GET", USERS],
      ["GET", `${USERS}/${fakeId}`],
      ["PATCH", `${USERS}/${fakeId}/block`],
      ["PATCH", `${USERS}/${fakeId}/unblock`],
      ["GET", TX],
      ["GET", ADMIN_CATEGORIES],
      ["GET", VENDORS],
    ];

    for (const [method, path] of probes) {
      const label = `${method} ${path.replace(/[0-9a-f]{24}/, ":id")}`;
      const anon = await call(method, path, null);
      check(`${label} without login -> 401 NO_CREDENTIALS`, anon.status === 401 && anon.body.code === "NO_CREDENTIALS", anon.body);
      const cust = await call(method, path, customer.token);
      check(`${label} as customer -> 403 FORBIDDEN`, cust.status === 403 && cust.body.code === "FORBIDDEN", cust.body);
      const vend = await call(method, path, vendorA.token);
      check(`${label} as vendor -> 403 FORBIDDEN`, vend.status === 403 && vend.body.code === "FORBIDDEN", vend.body);
      const block = await call(method, path, blockedAdmin.token);
      check(`${label} as blocked admin -> 403 ACCOUNT_BLOCKED`, block.status === 403 && block.body.code === "ACCOUNT_BLOCKED", block.body);
      const bad = await call(method, path, "not.a.jwt");
      check(`${label} with a bad token -> 401 INVALID_TOKEN`, bad.status === 401 && bad.body.code === "INVALID_TOKEN", bad.body);
    }

    // A customer / vendor trying to block a real user: nothing may change.
    await call("PATCH", `${USERS}/${victim.id}/block`, customer.token);
    await call("PATCH", `${USERS}/${victim.id}/block`, vendorA.token);
    check("a customer/vendor blocking a real user changes nothing", (await dbUser(victim.id))?.isBlocked !== true);

    const csrf = await fetch(`${baseUrl}${USERS}/${victim.id}/block`, {
      method: "PATCH",
      headers: { cookie: admin.cookie, origin: "https://evil.example" },
    });
    check("cookie PATCH from a foreign Origin -> 403 (CSRF guard), user not blocked", csrf.status === 403 && (await dbUser(victim.id))?.isBlocked !== true);

    check("admin GET dashboard -> 200", (await call("GET", DASH, admin.token)).status === 200);
    const cookieOk = await fetch(baseUrl + USERS, { headers: { cookie: admin.cookie } });
    check("admin session cookie also works (GET) -> 200", cookieOk.status === 200);
  }

  // ------------------------------------------------------------ user list
  section("2. User list: pagination, search, role and blocked filters, newest first");
  {
    const res = await call("GET", USERS, admin.token);
    check("-> 200 success, message, data array, pagination", res.status === 200 && res.body.success === true && typeof res.body.message === "string" && Array.isArray(res.body.data) && res.body.pagination?.totalItems === 8, res.body);
    check("every item has exactly the safe fields", res.body.data.every((u: Json) => keysOf(u) === SAFE_USER_FIELDS), res.body.data[0] && keysOf(res.body.data[0]));
    check("newest first (createdAt never increases)", res.body.data.every((u: Json, i: number, all: Json[]) => i === 0 || all[i - 1].createdAt >= u.createdAt));
    check("NO password / token / secret / Stripe id anywhere in the list", leaks(res.body).length === 0, leaks(res.body));

    const page1 = await call("GET", `${USERS}?page=1&limit=3`, admin.token);
    const page2 = await call("GET", `${USERS}?page=2&limit=3`, admin.token);
    const page3 = await call("GET", `${USERS}?page=3&limit=3`, admin.token);
    check("limit=3: 3 items, totalPages 3, hasNext true, hasPrevious false", page1.body.data.length === 3 && page1.body.pagination.totalPages === 3 && page1.body.pagination.hasNextPage === true && page1.body.pagination.hasPreviousPage === false, page1.body.pagination);
    check("page 3: 2 items, hasNext false, hasPrevious true", page3.body.data.length === 2 && page3.body.pagination.hasNextPage === false && page3.body.pagination.hasPreviousPage === true, page3.body.pagination);
    const ids = [...page1.body.data, ...page2.body.data, ...page3.body.data].map((u: Json) => u._id);
    check("the 3 pages together contain all 8 users once each", ids.length === 8 && new Set(ids).size === 8);
    const beyond = await call("GET", `${USERS}?page=99`, admin.token);
    check("page past the end -> 200 with an empty list", beyond.status === 200 && beyond.body.data.length === 0);

    const byName = await call("GET", `${USERS}?search=alice`, admin.token);
    check("search by NAME (case-insensitive, partial): finds Alice", byName.body.data.length === 1 && byName.body.data[0]._id === alice.id.toHexString(), byName.body.data);
    const byEmail = await call("GET", `${USERS}?search=${encodeURIComponent(vendorB.email.toUpperCase())}`, admin.token);
    check("search by EMAIL (case-insensitive): finds vendorB", byEmail.body.data.length === 1 && byEmail.body.data[0]._id === vendorB.id.toHexString(), byEmail.body.data);
    const byPart = await call("GET", `${USERS}?search=vendora`, admin.token);
    check("search by part of an email finds the user", byPart.body.data.some((u: Json) => u._id === vendorA.id.toHexString()));
    const none = await call("GET", `${USERS}?search=zzzz-nobody`, admin.token);
    check("search without a match -> 200, empty, totalItems 0", none.status === 200 && none.body.data.length === 0 && none.body.pagination.totalItems === 0);
    const regex = await call("GET", `${USERS}?search=${encodeURIComponent(".*")}`, admin.token);
    check("search '.*' is plain text, not a regex -> no match", regex.status === 200 && regex.body.data.length === 0, regex.body.data.length);

    const vendors = await call("GET", `${USERS}?role=vendor`, admin.token);
    check("role=vendor -> exactly the 2 vendors", vendors.body.data.length === 2 && vendors.body.data.every((u: Json) => u.role === "vendor"), vendors.body.data.map((u: Json) => u.role));
    const admins = await call("GET", `${USERS}?role=admin`, admin.token);
    check("role=admin -> the 3 admins", admins.body.data.length === 3 && admins.body.data.every((u: Json) => u.role === "admin"));
    const customers = await call("GET", `${USERS}?role=customer`, admin.token);
    check("role=customer -> the 3 customers", customers.body.data.length === 3);

    const blocked = await call("GET", `${USERS}?status=blocked`, admin.token);
    check("status=blocked -> only the blocked admin", blocked.body.data.length === 1 && blocked.body.data[0]._id === blockedAdmin.id.toHexString() && blocked.body.data[0].isBlocked === true, blocked.body.data);
    const unblocked = await call("GET", `${USERS}?status=unblocked`, admin.token);
    check("status=unblocked -> the other 7, none blocked", unblocked.body.data.length === 7 && unblocked.body.data.every((u: Json) => u.isBlocked === false), unblocked.body.pagination);
    const combo = await call("GET", `${USERS}?role=admin&status=blocked&search=blockedadmin`, admin.token);
    check("filters combine (role + status + search)", combo.body.data.length === 1 && combo.body.pagination.totalItems === 1);
    const fieldless = await usersCollection().insertOne({ name: "Old User", email: `old.${runId}@pizzahub.test`, role: "customer", createdAt: new Date(0) } as never);
    const unb2 = await call("GET", `${USERS}?status=unblocked&search=${encodeURIComponent("Old User")}`, admin.token);
    check("a user with NO isBlocked field counts as unblocked, shown as isBlocked false", unb2.body.data.length === 1 && unb2.body.data[0].isBlocked === false && unb2.body.data[0].subscriptionPlan === "free", unb2.body.data);
    await usersCollection().deleteOne({ _id: fieldless.insertedId });
  }

  // ------------------------------------------------------------ query validation
  section("3. Invalid query parameters -> consistent 400");
  {
    const bads = [
      "?role=superadmin",
      "?status=banned",
      "?page=0",
      "?page=-1",
      "?page=abc",
      "?limit=0",
      "?limit=51",
      "?limit=1.5",
      "?role=vendor&role=admin",
      `?search=${"x".repeat(101)}`,
    ];
    for (const q of bads) {
      const res = await call("GET", `${USERS}${q}`, admin.token);
      check(`GET users ${q.length > 40 ? q.slice(0, 30) + "..." : q} -> 400 VALIDATION_ERROR`, res.status === 400 && res.body.success === false && res.body.code === "VALIDATION_ERROR" && Array.isArray(res.body.errors) && res.body.errors.length > 0, res.body);
    }
  }

  // ------------------------------------------------------------ user details
  section("4. User details: safe fields only, invalid id 400, unknown id 404");
  {
    const res = await call("GET", `${USERS}/${vendorB.id}`, admin.token);
    check("-> 200 success", res.status === 200 && res.body.success === true && typeof res.body.message === "string", res.body);
    check("exactly the safe fields", keysOf(res.body.data) === SAFE_USER_FIELDS, keysOf(res.body.data));
    check("name, email, role, premium plan and expiry are right", res.body.data.name === "Vendor Beta" && res.body.data.email === vendorB.email && res.body.data.role === "vendor" && res.body.data.subscriptionPlan === "premium" && typeof res.body.data.subscriptionExpiresAt === "string", res.body.data);
    check("no password / token / secret / Stripe customer id anywhere", leaks(res.body).length === 0, leaks(res.body));

    const a = await call("GET", `${USERS}/${vendorA.id}`, admin.token);
    check("image and businessName come through", a.body.data.image === "https://example.com/a.png" && a.body.data.businessName === "Alpha Kitchen", a.body.data);
    const c = await call("GET", `${USERS}/${customer.id}`, admin.token);
    check("a customer: image/businessName null, free plan, expiry null, not blocked", c.body.data.image === null && c.body.data.businessName === null && c.body.data.subscriptionPlan === "free" && c.body.data.subscriptionExpiresAt === null && c.body.data.isBlocked === false, c.body.data);

    // A stored "premium" whose paid period has run out is shown as free (the same rule as the rest of the API).
    await usersCollection().updateOne({ _id: alice.id }, { $set: { subscriptionPlan: "premium", subscriptionExpiresAt: new Date(Date.now() - 1000) } });
    const expired = await call("GET", `${USERS}/${alice.id}`, admin.token);
    check("premium with a PAST expiry is shown as free (effective plan)", expired.body.data.subscriptionPlan === "free", expired.body.data);
    await usersCollection().updateOne({ _id: alice.id }, { $set: { subscriptionPlan: "free", subscriptionExpiresAt: null } });

    for (const bad of ["abc", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", `${vendorA.id}0`]) {
      const r = await call("GET", `${USERS}/${bad}`, admin.token);
      check(`GET /users/${bad.length > 12 ? bad.slice(0, 12) + "..." : bad} -> 400 VALIDATION_ERROR`, r.status === 400 && r.body.code === "VALIDATION_ERROR", r.body);
    }
    const missing = await call("GET", `${USERS}/${new ObjectId()}`, admin.token);
    check("valid but unknown id -> 404 USER_NOT_FOUND", missing.status === 404 && missing.body.code === "USER_NOT_FOUND" && missing.body.success === false, missing.body);
    const badBlock = await call("PATCH", `${USERS}/abc/block`, admin.token);
    const badUnblock = await call("PATCH", `${USERS}/abc/unblock`, admin.token);
    check("block / unblock with an invalid id -> 400", badBlock.status === 400 && badUnblock.status === 400, [badBlock.body, badUnblock.body]);
    const missBlock = await call("PATCH", `${USERS}/${new ObjectId()}/block`, admin.token);
    const missUnblock = await call("PATCH", `${USERS}/${new ObjectId()}/unblock`, admin.token);
    check("block / unblock of an unknown user -> 404", missBlock.status === 404 && missUnblock.status === 404 && missBlock.body.code === "USER_NOT_FOUND", [missBlock.body, missUnblock.body]);
  }

  // ------------------------------------------------------------ block / unblock
  section("5. Block / unblock");
  {
    // Give the victim real data first: it must all survive the block.
    const itemId = (await menuItemsCollection().insertOne({
      vendorId: vendorA.id, itemName: "Kept item", category: "Pizza", description: "x", price: 10,
      location: "Dhaka", images: ["https://example.com/k.jpg"], status: "approved", createdAt: new Date(),
    } as never)).insertedId;
    const orderId = (await ordersCollection().insertOne({
      itemId, vendorId: vendorA.id, customerId: victim.id, deliveryDate: new Date(Date.UTC(2031, 0, 1)),
      deliveryAddress: "Somewhere", status: "pending", createdAt: new Date(),
    } as never)).insertedId;

    const before = await call("GET", "/api/test/protected", victim.token);
    check("before: the victim's token works on a protected route -> 200", before.status === 200, before.body);
    const sessionsBefore = await getDB().collection("session").countDocuments({ userId: victim.id.toHexString() });
    const sessionsBeforeAlt = await getDB().collection("session").countDocuments({ userId: victim.id });
    check("before: the victim has a Better Auth session", sessionsBefore + sessionsBeforeAlt >= 1, { sessionsBefore, sessionsBeforeAlt });

    const res = await call("PATCH", `${USERS}/${victim.id}/block`, admin.token);
    check("block -> 200 success with the updated user (isBlocked true)", res.status === 200 && res.body.success === true && res.body.data._id === victim.id.toHexString() && res.body.data.isBlocked === true && keysOf(res.body.data) === SAFE_USER_FIELDS, res.body);
    check("stored in the database: isBlocked true", (await dbUser(victim.id))?.isBlocked === true);

    const after = await call("GET", "/api/test/protected", victim.token);
    check("the blocked user's OLD token is now refused -> 403 ACCOUNT_BLOCKED", after.status === 403 && after.body.code === "ACCOUNT_BLOCKED", after.body);
    const ordersTry = await call("GET", "/api/orders/my-orders", victim.token);
    check("...also on a real customer API (my-orders) -> 403 ACCOUNT_BLOCKED", ordersTry.status === 403 && ordersTry.body.code === "ACCOUNT_BLOCKED", ordersTry.body);
    const cookieTry = await fetch(`${baseUrl}/api/test/protected`, { headers: { cookie: victim.cookie } });
    check("...and the old session cookie is refused too (401 or 403)", cookieTry.status === 401 || cookieTry.status === 403, cookieTry.status);
    const sessionsAfter = await getDB().collection("session").countDocuments({ $or: [{ userId: victim.id.toHexString() }, { userId: victim.id }] });
    check("the victim's Better Auth sessions were deleted", sessionsAfter === 0, sessionsAfter);
    const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.CLIENT_URL },
      body: JSON.stringify({ email: victim.email, password: PASSWORD }),
    });
    check("the blocked user cannot sign in again (403)", signIn.status === 403, signIn.status);

    check("NOTHING of the user was deleted: user, order and item still exist", (await dbUser(victim.id)) !== null && (await ordersCollection().findOne({ _id: orderId })) !== null && (await menuItemsCollection().findOne({ _id: itemId })) !== null);
    const list = await call("GET", `${USERS}?status=blocked`, admin.token);
    check("the blocked list now has the victim", list.body.data.some((u: Json) => u._id === victim.id.toHexString()));

    const again = await call("PATCH", `${USERS}/${victim.id}/block`, admin.token);
    check("block an already blocked user -> 409 ALREADY_BLOCKED, still blocked", again.status === 409 && again.body.code === "ALREADY_BLOCKED" && again.body.success === false && (await dbUser(victim.id))?.isBlocked === true, again.body);

    const unblock = await call("PATCH", `${USERS}/${victim.id}/unblock`, admin.token);
    check("unblock -> 200 success with isBlocked false", unblock.status === 200 && unblock.body.success === true && unblock.body.data.isBlocked === false && keysOf(unblock.body.data) === SAFE_USER_FIELDS, unblock.body);
    check("stored in the database: isBlocked false", (await dbUser(victim.id))?.isBlocked === false);
    const signInAgain = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.CLIENT_URL },
      body: JSON.stringify({ email: victim.email, password: PASSWORD }),
    });
    check("after unblock the user can sign in again (200)", signInAgain.status === 200, signInAgain.status);
    const cookie2 = signInAgain.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const tok2 = ((await (await fetch(`${baseUrl}/api/auth/token`, { headers: { cookie: cookie2 } })).json()) as { token: string }).token;
    check("...and a fresh token works on a protected route -> 200", (await call("GET", "/api/test/protected", tok2)).status === 200);

    const unblockAgain = await call("PATCH", `${USERS}/${victim.id}/unblock`, admin.token);
    check("unblock an already unblocked user -> 409 ALREADY_UNBLOCKED", unblockAgain.status === 409 && unblockAgain.body.code === "ALREADY_UNBLOCKED" && unblockAgain.body.success === false, unblockAgain.body);

    // Body is not accepted (no reason field exists): refused loudly, nothing changes.
    const withBody = await call("PATCH", `${USERS}/${victim.id}/block`, admin.token, { reason: "spam", isBlocked: true, role: "admin" });
    check("a body with fields is refused -> 400, user NOT blocked", withBody.status === 400 && (await dbUser(victim.id))?.isBlocked === false, withBody.body);
    check("an empty JSON body {} is fine", (await call("PATCH", `${USERS}/${victim.id}/unblock`, admin.token, {})).status === 409);

    // Parallel: two admins block the same user at once; exactly one wins, the other gets 409.
    const race = await Promise.all([
      call("PATCH", `${USERS}/${victim.id}/block`, admin.token),
      call("PATCH", `${USERS}/${victim.id}/block`, admin2.token),
      call("PATCH", `${USERS}/${victim.id}/block`, admin.token),
    ]);
    const wins = race.filter((r) => r.status === 200).length;
    const conflicts = race.filter((r) => r.status === 409 && r.body.code === "ALREADY_BLOCKED").length;
    check("3 parallel blocks: exactly one 200, the rest 409 ALREADY_BLOCKED", wins === 1 && conflicts === 2, race.map((r) => r.status));
    await call("PATCH", `${USERS}/${victim.id}/unblock`, admin.token);
  }

  // ------------------------------------------------------------ self / admin protection
  section("6. An admin cannot block themselves or another admin");
  {
    const self = await call("PATCH", `${USERS}/${admin.id}/block`, admin.token);
    check("admin blocks THEMSELVES -> 403 CANNOT_BLOCK_SELF", self.status === 403 && self.body.code === "CANNOT_BLOCK_SELF" && self.body.success === false, self.body);
    check("...the admin is not blocked and still works", (await dbUser(admin.id))?.isBlocked !== true && (await call("GET", DASH, admin.token)).status === 200);

    const other = await call("PATCH", `${USERS}/${admin2.id}/block`, admin.token);
    check("admin blocks ANOTHER admin -> 403 CANNOT_BLOCK_ADMIN", other.status === 403 && other.body.code === "CANNOT_BLOCK_ADMIN", other.body);
    check("...the other admin is not blocked and still works", (await dbUser(admin2.id))?.isBlocked !== true && (await call("GET", DASH, admin2.token)).status === 200);

    // The refusal does not depend on which user blocks: a normal user cannot reach this at all (section 1).
    const unblockSelf = await call("PATCH", `${USERS}/${admin.id}/unblock`, admin.token);
    check("unblocking an admin who is not blocked -> 409 ALREADY_UNBLOCKED (no special case)", unblockSelf.status === 409 && unblockSelf.body.code === "ALREADY_UNBLOCKED", unblockSelf.body);

    // Roles cannot be changed through these endpoints (no mass assignment).
    const escalate = await call("PATCH", `${USERS}/${customer.id}/block`, admin.token, { role: "admin" });
    check("a body with `role` is refused and the user's role is unchanged", escalate.status === 400 && (await dbUser(customer.id))?.role === "customer", escalate.body);
    await call("PATCH", `${USERS}/${customer.id}/unblock`, admin.token);
  }

  // ------------------------------------------------------------ transactions
  section("7. Transactions: read-only list, filters, pagination, safe fields");
  {
    await seedTransaction(vendorA.id, "success", 1);
    await seedTransaction(vendorA.id, "failed", 2);
    await seedTransaction(vendorB.id, "pending", 3);
    await seedTransaction(vendorB.id, "cancelled", 4);
    await seedTransaction(vendorB.id, "expired", 5);
    await seedTransaction(vendorB.id, "success", 6);

    const res = await call("GET", TX, admin.token);
    check("-> 200 success, 6 transactions, pagination", res.status === 200 && res.body.success === true && res.body.data.length === 6 && res.body.pagination.totalItems === 6, res.body.pagination);
    check("newest first", res.body.data.map((t: Json) => t.stripeSessionId).join() === [6, 5, 4, 3, 2, 1].map((n) => `cs_test_admin_${runId}_${n}`).join(), res.body.data.map((t: Json) => t.stripeSessionId));
    const t = res.body.data[0];
    check("a transaction shows id, vendor, plan, amount, currency, status, session id, subscription id, createdAt", ["_id", "vendorId", "vendor", "plan", "amount", "currency", "status", "stripeSessionId", "stripeSubscriptionId", "createdAt"].every((k) => k in t) && keysOf(t) === "_id,amount,createdAt,currency,plan,status,stripeSessionId,stripeSubscriptionId,vendor,vendorId", keysOf(t));
    check("values are right (premium, 9.99, usd, success, sub id)", t.plan === "premium" && t.amount === 9.99 && t.currency === "usd" && t.status === "success" && t.stripeSubscriptionId === `sub_test_admin_${runId}_6`, t);
    check("vendor info has only _id, name, email and businessName", Object.keys(t.vendor).every((k) => ["_id", "name", "email", "businessName"].includes(k)) && t.vendor.name === "Vendor Beta", t.vendor);
    check("NO Stripe customer id, password, token or key anywhere", leaks(res.body).length === 0, leaks(res.body));

    for (const status of ["pending", "success", "failed", "cancelled", "expired"] as const) {
      const r = await call("GET", `${TX}?status=${status}`, admin.token);
      const expected = status === "success" ? 2 : 1;
      check(`status=${status} -> ${expected} transaction(s), all ${status}`, r.status === 200 && r.body.data.length === expected && r.body.data.every((x: Json) => x.status === status), r.body.data.map((x: Json) => x.status));
    }
    const byVendor = await call("GET", `${TX}?vendorId=${vendorA.id}`, admin.token);
    check("vendorId filter -> only that vendor's 2 transactions", byVendor.body.data.length === 2 && byVendor.body.data.every((x: Json) => x.vendorId === vendorA.id.toHexString()), byVendor.body.data.length);
    const both = await call("GET", `${TX}?vendorId=${vendorB.id}&status=success`, admin.token);
    check("vendorId + status combine", both.body.data.length === 1 && both.body.data[0].vendorId === vendorB.id.toHexString() && both.body.data[0].status === "success");
    const unknownVendor = await call("GET", `${TX}?vendorId=${new ObjectId()}`, admin.token);
    check("a valid but unknown vendorId -> 200, empty", unknownVendor.status === 200 && unknownVendor.body.data.length === 0 && unknownVendor.body.pagination.totalItems === 0);

    const p1 = await call("GET", `${TX}?limit=4`, admin.token);
    const p2 = await call("GET", `${TX}?limit=4&page=2`, admin.token);
    check("pagination: limit 4 -> 4 + 2, totalPages 2", p1.body.data.length === 4 && p2.body.data.length === 2 && p1.body.pagination.totalPages === 2 && p2.body.pagination.hasNextPage === false && new Set([...p1.body.data, ...p2.body.data].map((x: Json) => x._id)).size === 6, p1.body.pagination);

    for (const q of ["?status=paid", "?vendorId=abc", `?vendorId=${vendorA.id}&vendorId=${vendorB.id}`, "?page=0", "?limit=51"]) {
      const r = await call("GET", `${TX}${q}`, admin.token);
      check(`GET transactions ${q.length > 40 ? q.slice(0, 30) + "..." : q} -> 400 VALIDATION_ERROR`, r.status === 400 && r.body.code === "VALIDATION_ERROR", r.body);
    }

    // An orphaned transaction (the vendor account is gone) is still listed.
    const ghost = await seedTransaction(new ObjectId(), "failed", 7);
    const withGhost = await call("GET", `${TX}?status=failed`, admin.token);
    check("a transaction whose vendor no longer exists is listed with vendor null", withGhost.body.data.some((x: Json) => x._id === ghost.toHexString() && x.vendor === null));
    await transactionsCollection().deleteOne({ _id: ghost });
  }

  section("8. Admin cannot modify transactions (no write endpoint exists)");
  {
    const one = await transactionsCollection().findOne({});
    const snapshot = JSON.stringify(await transactionsCollection().find({}).sort({ _id: 1 }).toArray());
    const id = one!._id.toHexString();

    const attempts: [string, string, unknown][] = [
      ["POST", TX, { vendorId: vendorA.id.toHexString(), plan: "premium", amount: 1, currency: "usd", stripeSessionId: "cs_x", status: "success" }],
      ["PATCH", `${TX}/${id}`, { status: "success" }],
      ["PUT", `${TX}/${id}`, { status: "success" }],
      ["DELETE", `${TX}/${id}`, undefined],
      ["PATCH", `${TX}/${id}/status`, { status: "success" }],
      ["PUT", TX, { status: "success" }],
      ["DELETE", TX, undefined],
      ["GET", `${TX}/${id}`, undefined],
    ];

    for (const [method, path, body] of attempts) {
      const r = await call(method, path, admin.token, body);
      check(`${method} ${path.replace(/[0-9a-f]{24}/, ":id")} as admin -> 404 (route does not exist)`, r.status === 404 && r.body.success === false, [r.status, r.body]);
    }
    check("the transactions collection is byte-for-byte unchanged", JSON.stringify(await transactionsCollection().find({}).sort({ _id: 1 }).toArray()) === snapshot);
  }

  // ------------------------------------------------------------ dashboard
  section("9. Dashboard: real counts, no fabricated data");
  {
    // Known state. Start from a clean slate for the counted collections.
    await menuItemsCollection().deleteMany({});
    await ordersCollection().deleteMany({});

    const mk = (status: string, n: number) => ({
      vendorId: vendorA.id, itemName: `Dash ${status} ${n}`, category: "Pizza", description: "x", price: 10,
      location: "Dhaka", images: ["https://example.com/d.jpg"], status, createdAt: new Date(),
    });
    await menuItemsCollection().insertMany([mk("pending", 1), mk("pending", 2), mk("approved", 1), mk("approved", 2), mk("approved", 3), mk("rejected", 1), mk("inactive", 1)] as never);
    const itemId = (await menuItemsCollection().findOne({ status: "approved" }))!._id;
    const mo = (status: string, n: number) => ({
      itemId, vendorId: vendorA.id, customerId: customer.id, deliveryDate: new Date(Date.UTC(2031, 0, n)),
      deliveryAddress: "Somewhere", status, createdAt: new Date(Date.UTC(2030, 0, 1) + n * 1000),
    });
    await ordersCollection().insertMany([mo("pending", 1), mo("pending", 2), mo("accepted", 3), mo("rejected", 4), mo("cancelled", 5), mo("cancelled", 6)] as never);

    const usersNow = await usersCollection().countDocuments({});
    const res = await call("GET", DASH, admin.token);
    const d = res.body.data;
    check("-> 200 success with message", res.status === 200 && res.body.success === true && typeof res.body.message === "string", res.body);
    check("users: total/customers/vendors/admins/blocked match the database", d.users.total === usersNow && d.users.customers === 3 && d.users.vendors === 2 && d.users.admins === 3 && d.users.blocked === 1, d.users);
    check("menu items: total 7, pending 2, approved 3, rejected 1, inactive 1", d.menuItems.total === 7 && d.menuItems.pending === 2 && d.menuItems.approved === 3 && d.menuItems.rejected === 1 && d.menuItems.inactive === 1, d.menuItems);
    check("orders: total 6, pending 2, accepted 1, rejected 1, cancelled 2", d.orders.total === 6 && d.orders.pending === 2 && d.orders.accepted === 1 && d.orders.rejected === 1 && d.orders.cancelled === 2, d.orders);
    check("transactions: total 6, success 2, pending 1, failed 1, cancelled 1, expired 1", d.transactions.total === 6 && d.transactions.success === 2 && d.transactions.pending === 1 && d.transactions.failed === 1 && d.transactions.cancelled === 1 && d.transactions.expired === 1, d.transactions);
    check("active premium vendors = 1 (vendorB, not expired)", d.subscriptions.activePremiumVendors === 1, d.subscriptions);

    // Expired and non-vendor premium do NOT count; an active one does.
    await usersCollection().updateOne({ _id: vendorA.id }, { $set: { subscriptionPlan: "premium", subscriptionExpiresAt: new Date(Date.now() - 1000) } });
    await usersCollection().updateOne({ _id: customer.id }, { $set: { subscriptionPlan: "premium", subscriptionExpiresAt: new Date(Date.now() + 86_400_000) } });
    check("premium with a PAST expiry and premium on a non-vendor are not counted", (await call("GET", DASH, admin.token)).body.data.subscriptions.activePremiumVendors === 1);
    await usersCollection().updateOne({ _id: vendorA.id }, { $set: { subscriptionExpiresAt: new Date(Date.now() + 86_400_000) } });
    check("an active premium vendor is counted live (now 2)", (await call("GET", DASH, admin.token)).body.data.subscriptions.activePremiumVendors === 2);
    await usersCollection().updateOne({ _id: vendorA.id }, { $set: { subscriptionPlan: "free", subscriptionExpiresAt: null } });
    await usersCollection().updateOne({ _id: customer.id }, { $set: { subscriptionPlan: "free", subscriptionExpiresAt: null } });

    check("recent: at most 5 users, orders and transactions", d.recent.users.length === 5 && d.recent.orders.length === 5 && d.recent.transactions.length === 5, [d.recent.users.length, d.recent.orders.length, d.recent.transactions.length]);
    check("recent users have the safe fields only", d.recent.users.every((u: Json) => keysOf(u) === SAFE_USER_FIELDS));
    check("recent orders are newest first and carry no address or message", d.recent.orders.map((o: Json) => o.status).join() === "cancelled,cancelled,rejected,accepted,pending" && d.recent.orders.every((o: Json) => !("deliveryAddress" in o) && !("message" in o)), d.recent.orders);
    check("recent transactions are newest first", d.recent.transactions[0].stripeSessionId === `cs_test_admin_${runId}_6`);
    check("NO password / token / secret / Stripe customer id anywhere", leaks(res.body).length === 0, leaks(res.body));

    // Counts follow the data (nothing is cached): block a user, add an order, see it.
    await call("PATCH", `${USERS}/${alice.id}/block`, admin.token);
    await ordersCollection().insertOne(mo("pending", 7) as never);
    const live = (await call("GET", DASH, admin.token)).body.data;
    check("numbers update live: blocked 2, orders 7, pending orders 3", live.users.blocked === 2 && live.orders.total === 7 && live.orders.pending === 3, [live.users, live.orders]);
    await call("PATCH", `${USERS}/${alice.id}/unblock`, admin.token);

    // Empty database parts: zeros, not errors.
    await ordersCollection().deleteMany({});
    await menuItemsCollection().deleteMany({});
    await transactionsCollection().deleteMany({});
    const empty = await call("GET", DASH, admin.token);
    check("empty menu/orders/transactions -> 200 with zeros and empty recent lists", empty.status === 200 && empty.body.data.orders.total === 0 && empty.body.data.orders.pending === 0 && empty.body.data.menuItems.total === 0 && empty.body.data.transactions.total === 0 && empty.body.data.recent.orders.length === 0 && empty.body.data.recent.transactions.length === 0, empty.body.data);
  }

  // ------------------------------------------------------------ blocked vendor
  section("11. A blocked vendor's items leave the public menu and cannot be ordered (nothing is deleted)");
  {
    await menuItemsCollection().deleteMany({});
    await ordersCollection().deleteMany({});
    const mkItem = (vendorId: Id, name: string) => ({
      vendorId, itemName: name, category: "BlockedTest", description: "x", price: 10,
      location: "Dhaka", images: ["https://example.com/b.jpg"], status: "approved", createdAt: new Date(),
    });
    const itemA = (await menuItemsCollection().insertOne(mkItem(vendorA.id, "Alpha pizza") as never)).insertedId;
    const itemB = (await menuItemsCollection().insertOne(mkItem(vendorB.id, "Beta pizza") as never)).insertedId;
    const order = (path: string, token: string, item: Id) =>
      call("POST", path, token, { itemId: item.toHexString(), deliveryDate: "2099-01-01", deliveryAddress: "Somewhere" });

    // An order that exists BEFORE the block must stay as it is.
    const early = await order("/api/orders", customer.token, itemA);
    check("before the block: both items are public and vendorA's item can be ordered (201)", early.status === 201 && (await call("GET", "/api/menu-items?category=BlockedTest", null)).body.pagination.totalItems === 2, early.body);

    const blockRes = await call("PATCH", `${USERS}/${vendorA.id}/block`, admin.token);
    check("vendorA is blocked by the admin", blockRes.status === 200 && blockRes.body.data.isBlocked === true, blockRes.body);

    const list = await call("GET", "/api/menu-items?category=BlockedTest", null);
    check("public list: only vendorB's item, totalItems 1", list.status === 200 && list.body.data.length === 1 && list.body.data[0]._id === itemB.toHexString() && list.body.pagination.totalItems === 1, list.body);
    check("public detail of the blocked vendor's item -> 404", (await call("GET", `/api/menu-items/${itemA}`, null)).status === 404);
    check("public detail of the other vendor's item -> 200", (await call("GET", `/api/menu-items/${itemB}`, null)).status === 200);
    const featured = await call("GET", "/api/menu-items/featured", null);
    check("featured: only vendorB's item", featured.body.data.length === 1 && featured.body.data[0]._id === itemB.toHexString(), featured.body);
    const cats = await call("GET", "/api/categories", null);
    check("categories: the count follows (BlockedTest = 1)", cats.body.data.find((c: Json) => c.name === "BlockedTest")?.count === 1, cats.body);

    const refused = await order("/api/orders", alice.token, itemA);
    check("ordering the blocked vendor's item -> 409 MENU_ITEM_UNAVAILABLE", refused.status === 409 && refused.body.code === "MENU_ITEM_UNAVAILABLE", refused.body);
    check("...and no order was created", (await ordersCollection().countDocuments({ customerId: alice.id })) === 0);
    check("ordering the OTHER vendor's item still works (201)", (await order("/api/orders", alice.token, itemB)).status === 201);

    check("NOTHING was deleted: vendorA's item and the early order still exist, unchanged", (await menuItemsCollection().findOne({ _id: itemA }))?.status === "approved" && (await ordersCollection().findOne({ _id: new ObjectId(early.body.data._id) }))?.status === "pending");
    const myOrders = await call("GET", "/api/orders/my-orders", customer.token);
    check("the customer can still see and cancel the order placed before the block", myOrders.body.data.length === 1 && (await call("PATCH", `/api/orders/${early.body.data._id}/cancel`, customer.token)).status === 200);
    check("the blocked vendor themself is refused by the vendor APIs -> 403 ACCOUNT_BLOCKED", (await call("GET", "/api/vendor/orders", vendorA.token)).body.code === "ACCOUNT_BLOCKED");

    await call("PATCH", `${USERS}/${vendorA.id}/unblock`, admin.token);
    const back = await call("GET", "/api/menu-items?category=BlockedTest", null);
    check("after the unblock: both items are public again", back.body.pagination.totalItems === 2 && (await call("GET", `/api/menu-items/${itemA}`, null)).status === 200);
    check("...and the item can be ordered again (201)", (await order("/api/orders", alice.token, itemA)).status === 201);
  }

  // ------------------------------------------------------------ regression
  section("12. Other APIs are unchanged");
  {
    check("health, public menu, categories still 200", (await call("GET", "/api/health", null)).status === 200 && (await call("GET", "/api/menu-items", null)).status === 200 && (await call("GET", "/api/categories", null)).status === 200);
    check("admin menu API still works for an admin (200) and refuses a customer (403)", (await call("GET", "/api/admin/menu-items", admin.token)).status === 200 && (await call("GET", "/api/admin/menu-items", customer.token)).status === 403);
    check("vendor API still refuses an admin -> 403", (await call("GET", "/api/vendor/menu-items", admin.token)).status === 403);
    check("customer orders still refuse an admin -> 403, vendor orders too", (await call("GET", "/api/orders/my-orders", admin.token)).status === 403 && (await call("GET", "/api/vendor/orders", admin.token)).status === 403);
    check("an unknown /api/admin path is a plain 404 JSON, also anonymously", (await call("GET", "/api/admin/nope", null)).status === 404);
    check("an unblocked user works on their own APIs again", (await call("GET", "/api/orders/my-orders", customer.token)).status === 200);
  }

  // ------------------------------------------------------------ admin categories
  section("13. GET /api/admin/menu-items/categories: every status, case-insensitive, A-Z");
  {
    await menuItemsCollection().deleteMany({});

    const empty = await call("GET", ADMIN_CATEGORIES, admin.token);
    check("no menu items -> 200 with an empty list", empty.status === 200 && empty.body.success === true && Array.isArray(empty.body.data) && empty.body.data.length === 0, empty.body);

    const mk = (category: string, status: string, vendorId: Id, n: number) => ({
      vendorId, itemName: `Cat ${category.trim()} ${status} ${n}`, category, description: "x", price: 10,
      location: "Dhaka", images: ["https://example.com/c.jpg"], status, createdAt: new Date(),
    });
    await menuItemsCollection().insertMany([
      mk("Pizza", "approved", vendorA.id, 1),
      mk("pizza", "pending", vendorA.id, 2),
      mk("PIZZA", "rejected", vendorB.id, 3),
      mk("Classic Pizzas", "rejected", vendorA.id, 4),
      mk("Classic Pizzas", "inactive", vendorB.id, 5),
      mk("  Burgers ", "pending", vendorB.id, 6),
    ] as never);

    const res = await call("GET", ADMIN_CATEGORIES, admin.token);
    check("-> 200 { success, message, data }", res.status === 200 && res.body.success === true && res.body.message === "Categories fetched successfully" && Array.isArray(res.body.data) && !("pagination" in res.body), res.body);
    check("A-Z by name, \"Pizza\" / \"pizza\" / \"PIZZA\" are one category (first spelling), a blank-padded name is trimmed", JSON.stringify(res.body.data) === JSON.stringify([{ name: "Burgers", count: 1 }, { name: "Classic Pizzas", count: 2 }, { name: "PIZZA", count: 3 }]), res.body.data);
    check("every entry has exactly name and count", res.body.data.every((c: Json) => Object.keys(c).sort().join() === "count,name"));

    const pub = await call("GET", "/api/categories", null);
    check("the public /api/categories is unchanged: approved items only (just Pizza = 1)", pub.status === 200 && JSON.stringify(pub.body.data) === JSON.stringify([{ name: "Pizza", count: 1 }]), pub.body.data);

    const withQuery = await call("GET", `${ADMIN_CATEGORIES}?status=approved`, admin.token);
    check("a query parameter is refused -> 400 VALIDATION_ERROR", withQuery.status === 400 && withQuery.body.code === "VALIDATION_ERROR" && withQuery.body.success === false, withQuery.body);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const r = await call(method, ADMIN_CATEGORIES, admin.token, method === "DELETE" ? undefined : {});
      check(`${method} on the categories path is not a route -> 4xx, categories unchanged`, r.status >= 400 && r.status < 500, [r.status, r.body]);
    }
    check("...the categories are unchanged after those attempts", JSON.stringify((await call("GET", ADMIN_CATEGORIES, admin.token)).body.data) === JSON.stringify(res.body.data));
    check("NO password / token / secret anywhere", leaks(res.body).length === 0, leaks(res.body));
    await menuItemsCollection().deleteMany({});
  }

  // ------------------------------------------------------------ admin vendors
  section("14. GET /api/admin/vendors: every vendor, safe fields only, A-Z by name");
  {
    // A lower-case name and a vendor without businessName: the sort must ignore case, the field must be null.
    const lower = await usersCollection().insertOne({
      name: "aardvark Pizza", email: `aardvark.${runId}@pizzahub.test`, role: "vendor", isBlocked: true,
      subscriptionPlan: "premium", subscriptionExpiresAt: new Date(Date.now() + 86_400_000),
      stripeCustomerId: "cus_SECRET_aardvark", createdAt: new Date(),
    } as never);

    const res = await call("GET", VENDORS, admin.token);
    check("-> 200 { success, message, data } without pagination", res.status === 200 && res.body.success === true && res.body.message === "Vendors fetched successfully" && Array.isArray(res.body.data) && !("pagination" in res.body), res.body);
    check("exactly the 3 vendors (blocked ones included), no customers or admins", res.body.data.length === 3, res.body.data);
    check("each item has exactly _id, name, email, businessName", res.body.data.every((v: Json) => keysOf(v) === "_id,businessName,email,name"), res.body.data[0] && keysOf(res.body.data[0]));
    check("sorted A-Z by name ignoring case: aardvark, Vendor Alpha, Vendor Beta", res.body.data.map((v: Json) => v.name).join("|") === "aardvark Pizza|Vendor Alpha|Vendor Beta", res.body.data.map((v: Json) => v.name));
    const a = res.body.data.find((v: Json) => v._id === vendorA.id.toHexString());
    check("values come through: businessName set for vendorA, null when missing", a?.email === vendorA.email && a?.businessName === "Alpha Kitchen" && res.body.data[0].businessName === null, res.body.data);
    check("NO password / token / secret / subscription / Stripe id anywhere (vendorB and the extra vendor hold such values)", leaks(res.body).length === 0 && !JSON.stringify(res.body).includes("subscription") && !JSON.stringify(res.body).includes("stripe"), leaks(res.body));

    const withQuery = await call("GET", `${VENDORS}?search=alpha`, admin.token);
    check("a query parameter is refused -> 400 VALIDATION_ERROR", withQuery.status === 400 && withQuery.body.code === "VALIDATION_ERROR", withQuery.body);

    const snapshot = JSON.stringify(await usersCollection().find({}).sort({ _id: 1 }).toArray());
    for (const [method, path] of [["POST", VENDORS], ["PATCH", VENDORS], ["PUT", VENDORS], ["DELETE", VENDORS], ["GET", `${VENDORS}/${vendorA.id}`]] as const) {
      const r = await call(method, path, admin.token, method === "GET" || method === "DELETE" ? undefined : { name: "x" });
      check(`${method} ${path.replace(/[0-9a-f]{24}/, ":id")} as admin -> 404 (read-only, no such route)`, r.status === 404 && r.body.success === false, [r.status, r.body]);
    }
    check("the users collection is byte-for-byte unchanged", JSON.stringify(await usersCollection().find({}).sort({ _id: 1 }).toArray()) === snapshot);

    await usersCollection().deleteOne({ _id: lower.insertedId });
    const after = await call("GET", VENDORS, admin.token);
    check("the list follows the data: 2 vendors again", after.body.data.length === 2);
  }
} catch (error) {
  failures.push("script crashed");
  console.error("\nScript crashed:", error);
} finally {
  server.close();

  try {
    await getDB().dropDatabase();
  } catch (error) {
    console.error("Could not drop the throwaway database:", error);
  }

  await client.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("Failed:\n - " + failures.join("\n - "));
  process.exit(1);
}
