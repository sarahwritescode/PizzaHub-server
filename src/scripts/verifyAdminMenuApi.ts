/**
 * Checks the admin menu API end to end over real HTTP: `npm run verify:admin-menu`.
 *
 * Real sign-up, real Better Auth JWTs, real MongoDB. It never touches your real
 * data: DB_NAME is switched to a throwaway database (pizzahub_admenu_verify_<timestamp>)
 * BEFORE the app is loaded, and that database is dropped at the end.
 *
 * Users are created through the real sign-up; the admin (sign-up cannot create
 * one) and the blocked flag are set directly in the throwaway database, as in
 * the other verify scripts. Menu items are inserted directly so every status exists.
 */
process.env.DB_NAME = `pizzahub_admenu_verify_${Date.now()}`;

const { ObjectId } = await import("mongodb");
const { default: app } = await import("../app.js");
const { env } = await import("../config/env.js");
const { client, connectDB, getDB } = await import("../config/db.js");
const { initializeDatabase } = await import("../config/initDatabase.js");
const { buildOrder, menuItemsCollection, ordersCollection, usersCollection } = await import("../models/index.js");

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

const BASE = "/api/admin/menu-items";

interface TestUser {
  token: string;
  cookie: string;
  id: Id;
  email: string;
}

const makeUser = async (label: string, role: "customer" | "vendor"): Promise<TestUser> => {
  const email = `${label}.${runId}@pizzahub.test`.toLowerCase();

  const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.CLIENT_URL },
    body: JSON.stringify({ name: label, email, password: PASSWORD, role }),
  });
  if (!signUp.ok) throw new Error(`sign-up of ${label} failed: ${signUp.status} ${await signUp.text()}`);

  const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const tokenRes = await fetch(`${baseUrl}/api/auth/token`, { headers: { cookie } });
  const { token } = (await tokenRes.json()) as { token: string };

  const user = await usersCollection().findOne({ email });
  return { token, cookie, id: user!._id, email };
};

type Status = "pending" | "approved" | "rejected" | "inactive";

let seedCounter = 0;

/** Insert an item straight into the DB. createdAt strictly increases, so "newest first" is checkable. */
const seedItem = async (
  vendorId: Id,
  status: Status,
  itemName: string,
  category = "Seeded",
  createdAt = new Date(Date.UTC(2030, 0, 1) + ++seedCounter * 1000)
) => {
  const { insertedId } = await menuItemsCollection().insertOne({
    vendorId,
    itemName,
    category,
    description: "Inserted by the test",
    price: 100,
    location: "Dhaka",
    images: ["https://example.com/seed.jpg"],
    status,
    createdAt,
  } as never);
  return insertedId;
};

const dbItem = (id: string | Id) => menuItemsCollection().findOne({ _id: new ObjectId(String(id)) });
const dbStatus = async (id: string | Id) => (await dbItem(id))?.status;

const ITEM_FIELDS = "_id,category,createdAt,description,images,itemName,location,price,status,vendor,vendorId";

const server = app.listen(0);

try {
  await connectDB();
  await initializeDatabase();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  section("Setting up real users (sign-up + JWT)");
  const [vendorA, vendorB, customer, admin, blockedAdmin] = await Promise.all([
    makeUser("vendorA", "vendor"),
    makeUser("vendorB", "vendor"),
    makeUser("customer", "customer"),
    makeUser("admin", "customer"),
    makeUser("blockedAdmin", "customer"),
  ]);
  await usersCollection().updateOne({ _id: admin.id }, { $set: { role: "admin" } });
  await usersCollection().updateOne({ _id: blockedAdmin.id }, { $set: { role: "admin", isBlocked: true } });
  await usersCollection().updateOne({ _id: vendorA.id }, { $set: { businessName: "Vendor A Kitchen" } });
  check("5 users created with tokens", [vendorA, vendorB, customer, admin, blockedAdmin].every((u) => u.token.length > 20));

  // ------------------------------------------------------------ access control
  section("1. Access control: anonymous, customer, vendor, blocked admin (every endpoint)");
  {
    const probes: [string, string, unknown][] = [
      ["GET", BASE, undefined],
      ["PATCH", `${BASE}/${new ObjectId()}/approve`, undefined],
      ["PATCH", `${BASE}/${new ObjectId()}/reject`, undefined],
      ["PATCH", `${BASE}/${new ObjectId()}/status`, { status: "inactive" }],
      ["DELETE", `${BASE}/${new ObjectId()}`, undefined],
    ];

    // A real, pending item: it must come out of the whole section untouched.
    const guarded = await seedItem(vendorA.id, "pending", "Guarded item");

    for (const [method, path, body] of probes) {
      const label = `${method} ${path.replace(/[0-9a-f]{24}/, ":id")}`;
      const anon = await call(method, path, null, body);
      check(`${label} without login -> 401 NO_CREDENTIALS`, anon.status === 401 && anon.body.code === "NO_CREDENTIALS", anon.body);
      const cust = await call(method, path, customer.token, body);
      check(`${label} as customer -> 403 FORBIDDEN`, cust.status === 403 && cust.body.code === "FORBIDDEN", cust.body);
      const vend = await call(method, path, vendorA.token, body);
      check(`${label} as vendor -> 403 FORBIDDEN`, vend.status === 403 && vend.body.code === "FORBIDDEN", vend.body);
      const block = await call(method, path, blockedAdmin.token, body);
      check(`${label} as blocked admin -> 403 ACCOUNT_BLOCKED`, block.status === 403 && block.body.code === "ACCOUNT_BLOCKED", block.body);
    }

    check("bad token -> 401 INVALID_TOKEN", (await call("GET", BASE, "not.a.jwt")).body.code === "INVALID_TOKEN");

    // The real item, with real credentials that are NOT an admin's: nothing may change.
    await call("PATCH", `${BASE}/${guarded}/approve`, vendorA.token);
    await call("PATCH", `${BASE}/${guarded}/approve`, customer.token);
    await call("PATCH", `${BASE}/${guarded}/status`, vendorA.token, { status: "approved" });
    await call("DELETE", `${BASE}/${guarded}`, vendorA.token);
    check("a vendor/customer approving or deleting a real item changes nothing", (await dbStatus(guarded)) === "pending");
    check("...the item still exists", (await dbItem(guarded)) !== null);

    check("admin GET -> 200", (await call("GET", BASE, admin.token)).status === 200);
    const cookieOk = await fetch(baseUrl + BASE, { headers: { cookie: admin.cookie } });
    check("admin session cookie also works (GET) -> 200", cookieOk.status === 200);
    const csrf = await fetch(`${baseUrl}${BASE}/${guarded}/approve`, {
      method: "PATCH",
      headers: { cookie: admin.cookie, origin: "https://evil.example" },
    });
    check("cookie PATCH from a foreign Origin -> 403 (CSRF guard)", csrf.status === 403 && (await dbStatus(guarded)) === "pending");

    await menuItemsCollection().deleteMany({});
  }

  // ------------------------------------------------------------ list
  section("2. Admin list: all vendors, every status, vendor info, newest first");
  {
    const empty = await call("GET", BASE, admin.token);
    check("empty database -> 200, data [], totalItems 0", empty.status === 200 && empty.body.data.length === 0 && empty.body.pagination.totalItems === 0, empty.body);

    const a1 = await seedItem(vendorA.id, "pending", "Margherita Pizza", "Pizza");
    const a2 = await seedItem(vendorA.id, "approved", "Chicken Wings", "Chicken");
    const b1 = await seedItem(vendorB.id, "rejected", "Veggie Pizza", "Pizza");
    const b2 = await seedItem(vendorB.id, "inactive", "Pasta Rolls", "Pizza Rolls");
    const b3 = await seedItem(vendorB.id, "approved", "Beef Burger", "Burger");

    const res = await call("GET", BASE, admin.token);
    check("-> 200 success, message set", res.status === 200 && res.body.success === true && typeof res.body.message === "string", res.body);
    check("sees items of BOTH vendors, all four statuses", res.body.data.length === 5 && new Set(res.body.data.map((i: Json) => i.status)).size === 4, res.body.data.map((i: Json) => i.status));
    check(
      "newest first (createdAt descending)",
      res.body.data.map((i: Json) => i._id).join() === [b3, b2, b1, a2, a1].map(String).join(),
      res.body.data.map((i: Json) => i.itemName)
    );
    check("item fields: " + ITEM_FIELDS, Object.keys(res.body.data[0]).sort().join() === ITEM_FIELDS, Object.keys(res.body.data[0]));

    const mine = res.body.data.find((i: Json) => i._id === String(a1));
    check("vendor info attached: _id, name, email, businessName", mine.vendor._id === String(vendorA.id) && mine.vendor.name === "vendorA" && mine.vendor.email === vendorA.email && mine.vendor.businessName === "Vendor A Kitchen", mine.vendor);
    check("vendor info has nothing else (no role / plan / isBlocked / password fields)", Object.keys(mine.vendor).sort().join() === "_id,businessName,email,name", Object.keys(mine.vendor));
    check("vendorId is present on the item", mine.vendorId === String(vendorA.id));
    const other = res.body.data.find((i: Json) => i._id === String(b1));
    check("another vendor's item carries that vendor's info", other.vendor.email === vendorB.email);
    check("pagination block: page 1, limit 12, totalItems 5, totalPages 1", JSON.stringify(res.body.pagination) === JSON.stringify({ page: 1, limit: 12, totalItems: 5, totalPages: 1, hasNextPage: false, hasPreviousPage: false }), res.body.pagination);

    // An item whose vendor account is gone is still listed.
    const orphan = await seedItem(new ObjectId(), "pending", "Orphan Item", "Pizza");
    const withOrphan = await call("GET", `${BASE}?search=Orphan`, admin.token);
    check("item of a deleted vendor account is listed with vendor: null", withOrphan.body.data[0]?._id === String(orphan) && withOrphan.body.data[0].vendor === null, withOrphan.body);
    await menuItemsCollection().deleteOne({ _id: orphan });

    // ---------------------------------------------------------- filters
    section("3. Filters and pagination");
    const names = async (qs: string) => (await call("GET", `${BASE}?${qs}`, admin.token)).body.data.map((i: Json) => i.itemName).sort();

    for (const status of ["pending", "approved", "rejected", "inactive"] as const) {
      const r = await call("GET", `${BASE}?status=${status}`, admin.token);
      check(`?status=${status} -> only ${status} items, totalItems matches`, r.status === 200 && r.body.data.every((i: Json) => i.status === status) && r.body.pagination.totalItems === r.body.data.length && r.body.data.length > 0, r.body);
    }
    check("?category=pizza -> case-insensitive EXACT ('Pizza Rolls' excluded)", JSON.stringify(await names("category=pizza")) === JSON.stringify(["Margherita Pizza", "Veggie Pizza"]), await names("category=pizza"));
    check("?search=piz -> partial name match, case-insensitive", JSON.stringify(await names("search=PIZ")) === JSON.stringify(["Margherita Pizza", "Veggie Pizza"]), await names("search=PIZ"));
    check("?search=pizza matches the NAME only, not the category ('Pasta Rolls' has category 'Pizza Rolls')", !(await names("search=pizza")).includes("Pasta Rolls"));
    check("?search=a.b is literal text (regex characters are escaped) -> no match", (await names("search=a.*")).length === 0);
    check("?status=pending&category=pizza -> filters combine (AND)", JSON.stringify(await names("status=pending&category=pizza")) === JSON.stringify(["Margherita Pizza"]), await names("status=pending&category=pizza"));
    check("?status=approved&search=burger -> one item", JSON.stringify(await names("status=approved&search=burger")) === JSON.stringify(["Beef Burger"]));
    const none = await call("GET", `${BASE}?search=nothing-like-this`, admin.token);
    check("no match -> 200, data [], totalItems 0, totalPages 0", none.status === 200 && none.body.data.length === 0 && none.body.pagination.totalItems === 0 && none.body.pagination.totalPages === 0, none.body);

    const p1 = await call("GET", `${BASE}?limit=2&page=1`, admin.token);
    const p2 = await call("GET", `${BASE}?limit=2&page=2`, admin.token);
    const p3 = await call("GET", `${BASE}?limit=2&page=3`, admin.token);
    const p4 = await call("GET", `${BASE}?limit=2&page=4`, admin.token);
    check("limit=2: pages hold 2 / 2 / 1 / 0 items, totalItems 5, totalPages 3", [p1, p2, p3, p4].map((p) => p.body.data.length).join() === "2,2,1,0" && p1.body.pagination.totalItems === 5 && p1.body.pagination.totalPages === 3, p1.body.pagination);
    check("hasNextPage / hasPreviousPage correct on pages 1 and 3", p1.body.pagination.hasNextPage === true && p1.body.pagination.hasPreviousPage === false && p3.body.pagination.hasNextPage === false && p3.body.pagination.hasPreviousPage === true);
    const allIds = [...p1.body.data, ...p2.body.data, ...p3.body.data].map((i: Json) => i._id);
    check("pages together = every item once, in newest-first order, no repeats", allIds.join() === [b3, b2, b1, a2, a1].map(String).join(), allIds);
    const filteredPage = await call("GET", `${BASE}?status=approved&limit=1&page=2`, admin.token);
    check("pagination follows the filter (2 approved items, limit 1, page 2 -> 1 item, totalPages 2)", filteredPage.body.data.length === 1 && filteredPage.body.pagination.totalItems === 2 && filteredPage.body.pagination.totalPages === 2, filteredPage.body);

    for (const [qs, label] of [
      ["status=bogus", "invalid status"],
      ["status=", "empty status"],
      ["page=0", "page 0"],
      ["page=abc", "page abc"],
      ["limit=51", "limit above max"],
      ["limit=-1", "negative limit"],
      ["search=" + "x".repeat(101), "search over 100 chars"],
      ["status=pending&status=approved", "repeated status"],
    ] as const) {
      const r = await call("GET", `${BASE}?${qs}`, admin.token);
      check(`${label} -> 400 VALIDATION_ERROR`, r.status === 400 && r.body.code === "VALIDATION_ERROR" && Array.isArray(r.body.errors), r.body);
    }
    check("default limit is 12", (await call("GET", BASE, admin.token)).body.pagination.limit === 12);
    await menuItemsCollection().deleteMany({});
  }

  // ------------------------------------------------------------ approve
  section("4. Approve");
  {
    const pending = await seedItem(vendorA.id, "pending", "To approve");
    const res = await call("PATCH", `${BASE}/${pending}/approve`, admin.token);
    check("pending -> 200 success, message set", res.status === 200 && res.body.success === true && typeof res.body.message === "string", res.body);
    check("response data.status is approved, same _id", res.body.data._id === String(pending) && res.body.data.status === "approved");
    check("response data has the admin item shape + vendor", Object.keys(res.body.data).sort().join() === ITEM_FIELDS && res.body.data.vendor.email === vendorA.email, Object.keys(res.body.data));
    check("database now says approved", (await dbStatus(pending)) === "approved");
    const doc = await dbItem(pending);
    check("nothing else on the item changed", doc?.itemName === "To approve" && doc.price === 100 && doc.vendorId.equals(vendorA.id) && doc.images.length === 1);

    const pub = await call("GET", `/api/menu-items/${pending}`, null);
    check("the approved item is now on the public menu", pub.status === 200 && pub.body.data._id === String(pending), pub.body);

    const again = await call("PATCH", `${BASE}/${pending}/approve`, admin.token);
    check("approving it again -> 409 INVALID_STATUS_TRANSITION 'already approved'", again.status === 409 && again.body.code === "INVALID_STATUS_TRANSITION" && /already approved/.test(again.body.message), again.body);
    check("...still approved", (await dbStatus(pending)) === "approved");

    const rejected = await seedItem(vendorA.id, "rejected", "Rejected one");
    const fromRejected = await call("PATCH", `${BASE}/${rejected}/approve`, admin.token);
    check("rejected -> approve -> 409 (only pending can be approved)", fromRejected.status === 409 && fromRejected.body.code === "INVALID_STATUS_TRANSITION" && (await dbStatus(rejected)) === "rejected", fromRejected.body);

    const inactive = await seedItem(vendorA.id, "inactive", "Inactive one");
    const fromInactive = await call("PATCH", `${BASE}/${inactive}/approve`, admin.token);
    check("inactive -> approve -> 409 (only pending can be approved)", fromInactive.status === 409 && (await dbStatus(inactive)) === "inactive", fromInactive.body);

    const withBody = await seedItem(vendorA.id, "pending", "Approve with body");
    const emptyObj = await call("PATCH", `${BASE}/${withBody}/approve`, admin.token, {});
    check("an empty JSON body {} is fine -> 200", emptyObj.status === 200, emptyObj.body);
    const extra = await seedItem(vendorA.id, "pending", "Approve with extra field");
    const bad = await call("PATCH", `${BASE}/${extra}/approve`, admin.token, { status: "rejected" });
    check("a body field is refused -> 400 VALIDATION_ERROR, nothing changed", bad.status === 400 && bad.body.code === "VALIDATION_ERROR" && (await dbStatus(extra)) === "pending", bad.body);

    // Free-plan count: approving never changes it (pending and approved both count).
    const before = await menuItemsCollection().countDocuments({ vendorId: vendorB.id, status: { $in: ["pending", "approved"] } });
    const countItem = await seedItem(vendorB.id, "pending", "Count item");
    await call("PATCH", `${BASE}/${countItem}/approve`, admin.token);
    const after = await menuItemsCollection().countDocuments({ vendorId: vendorB.id, status: { $in: ["pending", "approved"] } });
    check("approving does not change the vendor's active-item count", after === before + 1);
  }

  // ------------------------------------------------------------ reject
  section("5. Reject");
  {
    const pending = await seedItem(vendorA.id, "pending", "To reject");
    const res = await call("PATCH", `${BASE}/${pending}/reject`, admin.token);
    check("pending -> 200 success, message set", res.status === 200 && res.body.success === true && typeof res.body.message === "string", res.body);
    check("response data.status is rejected", res.body.data._id === String(pending) && res.body.data.status === "rejected");
    check("database now says rejected", (await dbStatus(pending)) === "rejected");
    const pub = await call("GET", `/api/menu-items/${pending}`, null);
    check("a rejected item is not on the public menu (404)", pub.status === 404);

    const again = await call("PATCH", `${BASE}/${pending}/reject`, admin.token);
    check("rejecting it again -> 409 INVALID_STATUS_TRANSITION 'already rejected'", again.status === 409 && again.body.code === "INVALID_STATUS_TRANSITION" && /already rejected/.test(again.body.message), again.body);

    const approved = await seedItem(vendorA.id, "approved", "Approved one");
    const fromApproved = await call("PATCH", `${BASE}/${approved}/reject`, admin.token);
    check("approved -> reject -> 409 (only pending can be rejected), still approved", fromApproved.status === 409 && fromApproved.body.code === "INVALID_STATUS_TRANSITION" && (await dbStatus(approved)) === "approved", fromApproved.body);
    const inactive = await seedItem(vendorA.id, "inactive", "Inactive two");
    check("inactive -> reject -> 409", (await call("PATCH", `${BASE}/${inactive}/reject`, admin.token)).status === 409);

    const reason = await seedItem(vendorA.id, "pending", "Reject with reason");
    const withReason = await call("PATCH", `${BASE}/${reason}/reject`, admin.token, { reason: "Photo is blurry" });
    check("a `reason` is refused (the schema has nowhere to store it) -> 400, item untouched", withReason.status === 400 && withReason.body.errors?.[0]?.field === "reason" && (await dbStatus(reason)) === "pending", withReason.body);

    // The vendor can fix a rejected item: editing it resubmits it as pending.
    // Resubmitting needs a free slot on the Free plan (max 3 active items), and
    // earlier checks left vendorA with 3: clear the others so only this rule is tested.
    await menuItemsCollection().deleteMany({ vendorId: vendorA.id, _id: { $ne: pending } });
    const edit = await call("PATCH", `/api/vendor/menu-items/${pending}`, vendorA.token, { price: 123 });
    check("the vendor can edit the rejected item -> 200, back to pending", edit.status === 200 && edit.body.data.status === "pending", edit.body);
    const reReject = await call("PATCH", `${BASE}/${pending}/reject`, admin.token);
    check("...and the admin can reject the resubmitted item again -> 200", reReject.status === 200 && (await dbStatus(pending)) === "rejected");
  }

  // ------------------------------------------------------------ status
  section("6. PATCH /:id/status (same rules, no bypass)");
  {
    const p1 = await seedItem(vendorA.id, "pending", "Status approve");
    const toApproved = await call("PATCH", `${BASE}/${p1}/status`, admin.token, { status: "approved" });
    check("pending -> approved -> 200", toApproved.status === 200 && toApproved.body.data.status === "approved" && (await dbStatus(p1)) === "approved", toApproved.body);
    check("message names the new status", toApproved.body.message === "Menu item status changed to approved");

    const toInactive = await call("PATCH", `${BASE}/${p1}/status`, admin.token, { status: "inactive" });
    check("approved -> inactive -> 200 (leaves the public menu)", toInactive.status === 200 && (await dbStatus(p1)) === "inactive" && (await call("GET", `/api/menu-items/${p1}`, null)).status === 404, toInactive.body);

    const p2 = await seedItem(vendorA.id, "pending", "Status reject");
    check("pending -> rejected -> 200", (await call("PATCH", `${BASE}/${p2}/status`, admin.token, { status: "rejected" })).status === 200 && (await dbStatus(p2)) === "rejected");

    const refused: [Status, Status][] = [
      ["pending", "pending"],
      ["pending", "inactive"],
      ["approved", "approved"],
      ["approved", "pending"],
      ["approved", "rejected"],
      ["rejected", "rejected"],
      ["rejected", "approved"],
      ["rejected", "pending"],
      ["rejected", "inactive"],
      ["inactive", "inactive"],
      ["inactive", "approved"],
      ["inactive", "pending"],
      ["inactive", "rejected"],
    ];
    for (const [from, to] of refused) {
      const id = await seedItem(vendorA.id, from, `Refused ${from} to ${to}`);
      const r = await call("PATCH", `${BASE}/${id}/status`, admin.token, { status: to });
      check(`${from} -> ${to} -> 409 INVALID_STATUS_TRANSITION, item unchanged`, r.status === 409 && r.body.code === "INVALID_STATUS_TRANSITION" && (await dbStatus(id)) === from, r.body);
    }

    const target = await seedItem(vendorA.id, "pending", "Invalid status target");
    for (const body of [{ status: "bogus" }, { status: "APPROVED" }, { status: "" }, { status: null }, { status: 1 }, {}, { status: "approved", extra: 1 }, { isActive: true }]) {
      const r = await call("PATCH", `${BASE}/${target}/status`, admin.token, body);
      check(`body ${JSON.stringify(body)} -> 400 VALIDATION_ERROR`, r.status === 400 && r.body.code === "VALIDATION_ERROR" && Array.isArray(r.body.errors), r.body);
    }
    const noBody = await call("PATCH", `${BASE}/${target}/status`, admin.token);
    check("no body at all -> 400 VALIDATION_ERROR", noBody.status === 400 && noBody.body.code === "VALIDATION_ERROR", noBody.body);
    check("none of the invalid requests changed the item", (await dbStatus(target)) === "pending");
  }

  // ------------------------------------------------------------ ids / 404
  section("7. Invalid ids and missing items");
  {
    const missing = new ObjectId();
    const calls: [string, string, unknown][] = [
      ["PATCH", "approve", undefined],
      ["PATCH", "reject", undefined],
      ["PATCH", "status", { status: "approved" }],
      ["DELETE", "", undefined],
    ];

    for (const [method, tail, body] of calls) {
      const label = `${method} :id${tail ? "/" + tail : ""}`;
      for (const bad of ["not-an-id", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", "507f1f77bcf86cd79943901"]) {
        const r = await call(method, `${BASE}/${bad}${tail ? "/" + tail : ""}`, admin.token, body);
        check(`${label} with id "${bad}" -> 400 VALIDATION_ERROR`, r.status === 400 && r.body.code === "VALIDATION_ERROR" && r.body.errors?.[0]?.field === "id", r.body);
      }
      const r = await call(method, `${BASE}/${missing}${tail ? "/" + tail : ""}`, admin.token, body);
      check(`${label} with a well-formed but unknown id -> 404 MENU_ITEM_NOT_FOUND`, r.status === 404 && r.body.code === "MENU_ITEM_NOT_FOUND" && r.body.success === false, r.body);
    }
  }

  // ------------------------------------------------------------ delete
  section("8. Delete");
  {
    const item = await seedItem(vendorA.id, "approved", "Delete me");
    const res = await call("DELETE", `${BASE}/${item}`, admin.token);
    check("admin deletes another vendor's approved item -> 200, data._id", res.status === 200 && res.body.success === true && res.body.data._id === String(item), res.body);
    check("...it is gone from the database", (await dbItem(item)) === null);
    check("...and from the public menu (404)", (await call("GET", `/api/menu-items/${item}`, null)).status === 404);
    check("deleting it again -> 404 MENU_ITEM_NOT_FOUND", (await call("DELETE", `${BASE}/${item}`, admin.token)).body.code === "MENU_ITEM_NOT_FOUND");

    for (const status of ["pending", "rejected", "inactive"] as const) {
      const other = await seedItem(vendorB.id, status, `Delete ${status}`);
      check(`admin can delete a ${status} item of another vendor -> 200`, (await call("DELETE", `${BASE}/${other}`, admin.token)).status === 200 && (await dbItem(other)) === null);
    }

    // No side effects on neighbours or on other data.
    const keep = await seedItem(vendorA.id, "approved", "Keep me");
    const target = await seedItem(vendorA.id, "approved", "Delete me too");
    const usersBefore = await usersCollection().countDocuments();
    await call("DELETE", `${BASE}/${target}`, admin.token);
    check("other items and users are untouched", (await dbItem(keep)) !== null && (await usersCollection().countDocuments()) === usersBefore);

    // Open orders block the delete (same rule as the vendor's own delete).
    const ordered = await seedItem(vendorA.id, "approved", "Has an order");
    const order = buildOrder({ itemId: ordered, vendorId: vendorA.id, customerId: customer.id, deliveryDate: "2099-01-01", deliveryAddress: "Somewhere 1" });
    const { insertedId: orderId } = await ordersCollection().insertOne(order as never);
    const blocked = await call("DELETE", `${BASE}/${ordered}`, admin.token);
    check("item with an open order -> 409 ITEM_HAS_OPEN_ORDERS", blocked.status === 409 && blocked.body.code === "ITEM_HAS_OPEN_ORDERS", blocked.body);
    check("...it was not deleted, the order is untouched", (await dbItem(ordered)) !== null && (await ordersCollection().findOne({ _id: orderId }))?.status === "pending");
    await ordersCollection().updateOne({ _id: orderId }, { $set: { status: "cancelled" } });
    check("after the order is cancelled it can be deleted -> 200", (await call("DELETE", `${BASE}/${ordered}`, admin.token)).status === 200);
    check("the (cancelled) order record is left as it was", (await ordersCollection().findOne({ _id: orderId }))?.status === "cancelled");
  }

  // ------------------------------------------------------------ concurrency
  section("9. Two admins at the same time");
  {
    const item = await seedItem(vendorA.id, "pending", "Race");
    const [first, second] = await Promise.all([
      call("PATCH", `${BASE}/${item}/approve`, admin.token),
      call("PATCH", `${BASE}/${item}/approve`, admin.token),
    ]);
    const codes = [first.status, second.status].sort().join();
    check("two parallel approves -> exactly one 200 and one 409", codes === "200,409", [first.body, second.body]);

    const item2 = await seedItem(vendorA.id, "pending", "Race approve vs reject");
    const [approve, reject] = await Promise.all([
      call("PATCH", `${BASE}/${item2}/approve`, admin.token),
      call("PATCH", `${BASE}/${item2}/reject`, admin.token),
    ]);
    check("parallel approve and reject -> exactly one wins, the other is 409", [approve.status, reject.status].sort().join() === "200,409", [approve.body, reject.body]);
    const final = await dbStatus(item2);
    check("...and the stored status is the winner's", (approve.status === 200 && final === "approved") || (reject.status === 200 && final === "rejected"), final);
  }

  // ------------------------------------------------------------ regression
  section("10. Public and vendor APIs are unchanged");
  {
    await menuItemsCollection().deleteMany({});
    const approved = await seedItem(vendorA.id, "approved", "Public one");
    const pub = await call("GET", "/api/menu-items?limit=50", null);
    check("public list: 200, only approved, still hides vendorId/status", pub.status === 200 && pub.body.data.length === 1 && pub.body.data.every((i: Json) => !("vendorId" in i) && !("status" in i)), pub.body);
    check("public categories / featured / health still 200", (await call("GET", "/api/categories", null)).status === 200 && (await call("GET", "/api/menu-items/featured", null)).status === 200 && (await call("GET", "/api/health", null)).status === 200);

    const mine = await call("GET", "/api/vendor/menu-items", vendorA.token);
    check("vendor list: 200, own items, no vendorId in items", mine.status === 200 && mine.body.data.length === 1 && !("vendorId" in mine.body.data[0]) && !("vendor" in mine.body.data[0]), mine.body);
    const created = await call("POST", "/api/vendor/menu-items", vendorA.token, { itemName: "New", category: "Pizza", description: "Hot", price: 10, location: "Dhaka", images: ["https://example.com/a.jpg"] });
    check("vendor create still works -> 201 pending", created.status === 201 && created.body.data.status === "pending", created.body);
    const toggle = await call("PATCH", `/api/vendor/menu-items/${approved}/availability`, vendorA.token, { isActive: false });
    check("vendor availability toggle still works -> 200 inactive", toggle.status === 200 && toggle.body.data.status === "inactive", toggle.body);
    const adminOnVendor = await call("GET", "/api/vendor/menu-items", admin.token);
    check("an admin is still refused by the vendor endpoints -> 403", adminOnVendor.status === 403);
    check("an admin test route still works", (await call("GET", "/api/test/admin", admin.token)).status === 200);
    check("unknown admin route -> 404 JSON", (await call("GET", "/api/admin/nope", null)).body.success === false);
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
