/**
 * Checks the vendor menu API end to end over real HTTP: `npm run verify:vendor`.
 *
 * Real sign-up, real Better Auth JWTs, real MongoDB transactions. It never
 * touches your real data: DB_NAME is switched to a throwaway database
 * (pizzahub_vendor_verify_<timestamp>) BEFORE the app is loaded, and that
 * database is dropped at the end.
 *
 * "Admin approval" does not exist as an API yet, so where a test needs an
 * approved/rejected item it changes the status directly in the throwaway DB.
 */
process.env.DB_NAME = `pizzahub_vendor_verify_${Date.now()}`;

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

const BASE = "/api/vendor/menu-items";

interface TestUser {
  token: string;
  cookie: string;
  id: InstanceType<typeof ObjectId>;
  email: string;
}

/** Real sign-up through Better Auth, then a real JWT from /api/auth/token. */
const makeUser = async (label: string, role: "customer" | "vendor"): Promise<TestUser> => {
  const email = `${label}.${runId}@pizzahub.test`.toLowerCase(); // Better Auth lower-cases emails

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

const validBody = (itemName = "Test Pizza") => ({
  itemName,
  category: "Pizza",
  description: "Tasty and hot",
  price: 450,
  location: "Dhaka",
  images: ["https://example.com/a.jpg"],
});

type Status = "pending" | "approved" | "rejected" | "inactive";

/** Insert an item straight into the DB (simulates admin approval etc.). */
const seedItem = async (vendorId: InstanceType<typeof ObjectId>, status: Status, itemName = `Seed ${status}`) => {
  const { insertedId } = await menuItemsCollection().insertOne({
    vendorId,
    itemName,
    category: "Seeded",
    description: "Inserted by the test",
    price: 100,
    location: "Dhaka",
    images: ["https://example.com/seed.jpg"],
    status,
    createdAt: new Date(),
  } as never);
  return insertedId;
};

const setStatus = (id: InstanceType<typeof ObjectId>, status: Status) =>
  menuItemsCollection().updateOne({ _id: id }, { $set: { status } });

const dbItem = (id: string | InstanceType<typeof ObjectId>) => menuItemsCollection().findOne({ _id: new ObjectId(String(id)) });
const activeCount = (vendorId: InstanceType<typeof ObjectId>) =>
  menuItemsCollection().countDocuments({ vendorId, status: { $in: ["pending", "approved"] } });
const totalCount = (vendorId: InstanceType<typeof ObjectId>) => menuItemsCollection().countDocuments({ vendorId });

const setPlan = (user: TestUser, plan: "free" | "premium", expiresAt: Date | null) =>
  usersCollection().updateOne({ _id: user.id }, { $set: { subscriptionPlan: plan, subscriptionExpiresAt: expiresAt } });

const DAY = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + 30 * DAY);
const past = () => new Date(Date.now() - DAY);

const server = app.listen(0);

try {
  await connectDB();
  await initializeDatabase();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  section("Setting up real users (sign-up + JWT)");
  const [vendorA, vendorB, customer, adminUser, blocked] = await Promise.all([
    makeUser("vendorA", "vendor"),
    makeUser("vendorB", "vendor"),
    makeUser("customer", "customer"),
    makeUser("adminUser", "customer"),
    makeUser("blocked", "vendor"),
  ]);
  await usersCollection().updateOne({ _id: adminUser.id }, { $set: { role: "admin" } });
  await usersCollection().updateOne({ _id: blocked.id }, { $set: { isBlocked: true } });
  check("5 users created with tokens", [vendorA, vendorB, customer, adminUser, blocked].every((u) => u.token.length > 20));
  check("new vendors start on the free plan", (await usersCollection().findOne({ _id: vendorA.id }))?.subscriptionPlan === "free");

  // ------------------------------------------------------------ access control
  section("1. Access control (customer, admin, anonymous, blocked)");
  {
    const probes: [string, string, unknown][] = [
      ["GET", BASE, undefined],
      ["POST", BASE, validBody()],
      ["PATCH", `${BASE}/${new ObjectId()}`, { price: 10 }],
      ["PATCH", `${BASE}/${new ObjectId()}/availability`, { isActive: false }],
      ["DELETE", `${BASE}/${new ObjectId()}`, undefined],
    ];

    for (const [method, path, body] of probes) {
      const label = `${method} ${path.replace(/[0-9a-f]{24}/, ":id")}`;
      const anon = await call(method, path, null, body);
      check(`${label} without login -> 401 NO_CREDENTIALS`, anon.status === 401 && anon.body.code === "NO_CREDENTIALS", anon.body);
      const cust = await call(method, path, customer.token, body);
      check(`${label} as customer -> 403 FORBIDDEN`, cust.status === 403 && cust.body.code === "FORBIDDEN", cust.body);
      const admin = await call(method, path, adminUser.token, body);
      check(`${label} as admin -> 403 FORBIDDEN`, admin.status === 403 && admin.body.code === "FORBIDDEN", admin.body);
      const block = await call(method, path, blocked.token, body);
      check(`${label} as blocked vendor -> 403 ACCOUNT_BLOCKED`, block.status === 403 && block.body.code === "ACCOUNT_BLOCKED", block.body);
    }

    check("bad token -> 401 INVALID_TOKEN", (await call("GET", BASE, "not.a.jwt")).body.code === "INVALID_TOKEN");
    check("nothing was created by the rejected requests", (await menuItemsCollection().countDocuments()) === 0);

    const cookieOk = await fetch(baseUrl + BASE, { headers: { cookie: vendorA.cookie } });
    check("vendor session cookie also works (GET) -> 200", cookieOk.status === 200);
    const csrf = await fetch(baseUrl + BASE, {
      method: "POST",
      headers: { cookie: vendorA.cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    check("cookie POST from a foreign Origin -> 403 (CSRF guard)", csrf.status === 403);
    check("existing GET /api/test/vendor still 200 for a vendor", (await call("GET", "/api/test/vendor", vendorA.token)).status === 200);
  }

  // ------------------------------------------------------------ create
  section("2. Create menu item");
  let createdId = "";
  {
    const empty = await call("GET", BASE, vendorA.token);
    check("vendor with no items -> 200, data [], totalItems 0", empty.status === 200 && empty.body.data.length === 0 && empty.body.pagination.totalItems === 0, empty.body);

    const res = await call("POST", BASE, vendorA.token, { ...validBody(), itemName: "  Spaced Name  " });
    createdId = res.body.data?._id;
    check("-> 201 success, message set", res.status === 201 && res.body.success === true && typeof res.body.message === "string", res.body);
    check("status is pending", res.body.data.status === "pending", res.body.data);
    check("itemName is trimmed", res.body.data.itemName === "Spaced Name");
    check("response has no vendorId", !("vendorId" in res.body.data));
    check("response fields: _id,itemName,category,description,price,location,images,status,createdAt", Object.keys(res.body.data).sort().join() === "_id,category,createdAt,description,images,itemName,location,price,status");

    const doc = await dbItem(createdId);
    check("stored vendorId = the logged-in vendor (from the token, not the body)", doc?.vendorId.equals(vendorA.id) === true);
    check("stored status = pending", doc?.status === "pending");

    // Fields the client must not control
    const forbidden: [string, Record<string, unknown>][] = [
      ["vendorId", { vendorId: vendorB.id.toHexString() }],
      ["status approved", { status: "approved" }],
      ["status pending", { status: "pending" }],
      ["createdAt", { createdAt: "2000-01-01T00:00:00Z" }],
      ["_id", { _id: new ObjectId().toHexString() }],
      ["role", { role: "admin" }],
      ["subscriptionPlan", { subscriptionPlan: "premium" }],
      ["subscriptionExpiresAt", { subscriptionExpiresAt: "2099-01-01" }],
      ["isActive", { isActive: true }],
      ["an unknown field", { foo: "bar" }],
    ];
    for (const [label, extra] of forbidden) {
      const r = await call("POST", BASE, vendorA.token, { ...validBody(), ...extra });
      check(`create with ${label} in the body -> 400`, r.status === 400 && r.body.code === "VALIDATION_ERROR", r.body);
    }
    const named = await call("POST", BASE, vendorA.token, { ...validBody(), vendorId: vendorB.id.toHexString(), status: "approved" });
    check("the error names each refused field (vendorId, status)", named.body.errors?.map((e: Json) => e.field).sort().join() === "status,vendorId", named.body);
    check("none of those created anything (still 1 item)", (await totalCount(vendorA.id)) === 1);

    const body = validBody();
    const invalid: [string, unknown][] = [
      ["empty object", {}],
      ["array body", []],
      ["string body", '"text"'],
      ["malformed JSON", "{not json"],
      ["no body at all", undefined],
      ...(["itemName", "category", "description", "price", "location", "images"] as const).map((k): [string, unknown] => {
        const { [k]: _omitted, ...rest } = body;
        return [`missing ${k}`, rest];
      }),
      ["empty itemName", { ...body, itemName: "" }],
      ["blank itemName", { ...body, itemName: "   " }],
      ["itemName too long", { ...body, itemName: "x".repeat(101) }],
      ["description too long", { ...body, description: "x".repeat(1001) }],
      ["price 0", { ...body, price: 0 }],
      ["price negative", { ...body, price: -5 }],
      ["price as string", { ...body, price: "10" }],
      ["price null", { ...body, price: null }],
      ["price too big", { ...body, price: 1e9 }],
      ["images empty array", { ...body, images: [] }],
      ["images not a URL", { ...body, images: ["not-a-url"] }],
      ["images javascript: URL", { ...body, images: ["javascript:alert(1)"] }],
      ["images ftp: URL", { ...body, images: ["ftp://example.com/a.jpg"] }],
      ["images a string, not an array", { ...body, images: "https://example.com/a.jpg" }],
      ["images with a number", { ...body, images: [123] }],
      ["11 images", { ...body, images: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.jpg`) }],
    ];
    for (const [label, payload] of invalid) {
      const r = await call("POST", BASE, vendorA.token, payload);
      check(`create with ${label} -> 400`, r.status === 400 && r.body.success === false, r);
    }
    check("invalid requests created nothing (still 1 item)", (await totalCount(vendorA.id)) === 1);
  }

  // ------------------------------------------------------------ list
  section("3. List my menu items (own items only, every status)");
  {
    const lister = await makeUser("lister", "vendor");
    const [p, a, r, i] = await Promise.all((["pending", "approved", "rejected", "inactive"] as const).map((s) => seedItem(lister.id, s)));
    await seedItem(vendorB.id, "approved", "Belongs to B");

    const res = await call("GET", BASE, lister.token);
    const statuses = res.body.data.map((x: Json) => x.status).sort().join();
    check("sees pending, approved, rejected and inactive", res.status === 200 && statuses === "approved,inactive,pending,rejected", statuses);
    check("never sees another vendor's item", !res.body.data.some((x: Json) => x.itemName === "Belongs to B"));
    check("item fields incl. status, no vendorId", Object.keys(res.body.data[0]).sort().join() === "_id,category,createdAt,description,images,itemName,location,price,status");
    check("pagination block (page 1, limit 12, 4 items)", res.body.pagination.page === 1 && res.body.pagination.limit === 12 && res.body.pagination.totalItems === 4 && res.body.pagination.totalPages === 1);
    check("newest first", res.body.data.every((x: Json, n: number, all: Json[]) => n === 0 || new Date(all[n - 1].createdAt) >= new Date(x.createdAt)));

    const onlyPending = await call("GET", `${BASE}?status=pending`, lister.token);
    check("?status=pending -> only pending", onlyPending.body.data.length === 1 && onlyPending.body.data[0]._id === p.toHexString());
    const paged = await call("GET", `${BASE}?limit=3&page=2`, lister.token);
    check("?limit=3&page=2 -> 1 item, hasPreviousPage", paged.body.data.length === 1 && paged.body.pagination.totalPages === 2 && paged.body.pagination.hasPreviousPage === true);
    for (const bad of ["status=approvedd", "page=0", "limit=51", "limit=abc"]) {
      check(`?${bad} -> 400`, (await call("GET", `${BASE}?${bad}`, lister.token)).status === 400);
    }
    check("vendorB's list has only B's own item", (await call("GET", BASE, vendorB.token)).body.data.every((x: Json) => x.itemName === "Belongs to B"));
    void a; void r; void i;

    section("4. Public Menu API still hides pending / inactive / rejected");
    const pub = await call("GET", "/api/menu-items?limit=50", null);
    const pubNames = pub.body.data.map((x: Json) => x.itemName);
    check("public list: only approved items", pub.status === 200 && pub.body.pagination.totalItems === (await menuItemsCollection().countDocuments({ status: "approved" })), pub.body.pagination);
    check("pending item (created above) not public", !pubNames.includes("Spaced Name"));
    check("public single: pending -> 404", (await call("GET", `/api/menu-items/${createdId}`, null)).status === 404);
    check("public single: inactive -> 404", (await call("GET", `/api/menu-items/${i}`, null)).status === 404);
    check("public single: rejected -> 404", (await call("GET", `/api/menu-items/${r}`, null)).status === 404);
    check("public single: approved -> 200", (await call("GET", `/api/menu-items/${a}`, null)).status === 200);
  }

  // ------------------------------------------------------------ update
  section("5. Update own menu item");
  {
    const vendorU = await makeUser("vendorU", "vendor");
    const created = await call("POST", BASE, vendorU.token, validBody("Updatable"));
    const id: string = created.body.data._id;

    const upd = await call("PATCH", `${BASE}/${id}`, vendorU.token, { price: 500, description: "New text" });
    check("pending item: PATCH price+description -> 200", upd.status === 200 && upd.body.data.price === 500 && upd.body.data.description === "New text", upd.body);
    check("it stays pending", upd.body.data.status === "pending");
    check("only the sent fields changed", upd.body.data.itemName === "Updatable" && upd.body.data.category === "Pizza");
    check("DB has the new values", (await dbItem(id))?.price === 500);

    // approved item: edit -> back to pending
    await setStatus(new ObjectId(id), "approved");
    check("(setup) item is public while approved", (await call("GET", `/api/menu-items/${id}`, null)).status === 200);
    const edit = await call("PATCH", `${BASE}/${id}`, vendorU.token, { itemName: "Renamed" });
    check("approved item: content change -> 200 and status pending again", edit.status === 200 && edit.body.data.status === "pending" && edit.body.data.itemName === "Renamed", edit.body);
    check("message says it needs approval again", /pending approval/i.test(edit.body.message), edit.body.message);
    check("DB status is pending", (await dbItem(id))?.status === "pending");
    check("it disappeared from the public menu (no approval bypass)", (await call("GET", `/api/menu-items/${id}`, null)).status === 404);

    // same values -> nothing happens
    await setStatus(new ObjectId(id), "approved");
    const same = await call("PATCH", `${BASE}/${id}`, vendorU.token, { itemName: "Renamed", price: 500, images: ["https://example.com/a.jpg"] });
    check("approved item: sending the SAME values -> 200, still approved", same.status === 200 && same.body.data.status === "approved", same.body);
    check("message says no changes", /no changes/i.test(same.body.message));
    const imgs = await call("PATCH", `${BASE}/${id}`, vendorU.token, { images: ["https://example.com/a.jpg", "https://example.com/b.jpg"] });
    check("changing images counts as a content change -> pending", imgs.body.data.status === "pending", imgs.body);

    // protected fields never change
    const before = await dbItem(id);
    const protectedBodies: [string, Record<string, unknown>][] = [
      ["status", { status: "approved" }],
      ["vendorId", { vendorId: vendorB.id.toHexString() }],
      ["createdAt", { createdAt: "2000-01-01T00:00:00Z" }],
      ["_id", { _id: new ObjectId().toHexString() }],
      ["role", { role: "admin" }],
      ["subscriptionPlan", { subscriptionPlan: "premium" }],
      ["isActive", { isActive: true }],
      ["status next to a valid field", { price: 1, status: "approved" }],
    ];
    for (const [label, body] of protectedBodies) {
      const r = await call("PATCH", `${BASE}/${id}`, vendorU.token, body);
      check(`PATCH with ${label} -> 400`, r.status === 400 && r.body.code === "VALIDATION_ERROR", r.body);
    }
    const after = await dbItem(id);
    check("the item is byte-for-byte unchanged after all of them", JSON.stringify(before) === JSON.stringify(after));

    const badPatches: [string, unknown][] = [
      ["empty object", {}], ["no body", undefined], ["price -1", { price: -1 }], ["price string", { price: "5" }],
      ["bad image", { images: ["nope"] }], ["empty itemName", { itemName: "" }],
    ];
    for (const [label, body] of badPatches) {
      const r = await call("PATCH", `${BASE}/${id}`, vendorU.token, body);
      check(`PATCH with ${label} -> 400`, r.status === 400, r.body);
    }
    check("PATCH invalid id -> 400", (await call("PATCH", `${BASE}/INVALID_ID`, vendorU.token, { price: 1 })).status === 400);
    const unknown = await call("PATCH", `${BASE}/${new ObjectId()}`, vendorU.token, { price: 1 });
    check("PATCH unknown id -> 404 MENU_ITEM_NOT_FOUND", unknown.status === 404 && unknown.body.code === "MENU_ITEM_NOT_FOUND", unknown.body);

    // ownership
    const snapshot = JSON.stringify(await dbItem(id));
    const otherEdit = await call("PATCH", `${BASE}/${id}`, vendorB.token, { price: 1 });
    check("OTHER vendor PATCH -> 404 (same as missing, nothing leaked)", otherEdit.status === 404 && otherEdit.body.code === "MENU_ITEM_NOT_FOUND", otherEdit.body);
    const otherAvail = await call("PATCH", `${BASE}/${id}/availability`, vendorB.token, { isActive: false });
    check("OTHER vendor availability -> 404", otherAvail.status === 404);
    const otherDelete = await call("DELETE", `${BASE}/${id}`, vendorB.token);
    check("OTHER vendor DELETE -> 404", otherDelete.status === 404);
    check("the item is untouched and still exists", JSON.stringify(await dbItem(id)) === snapshot);

    // rejected -> edit resubmits
    const rejectedId = await seedItem(vendorU.id, "rejected");
    const resub = await call("PATCH", `${BASE}/${rejectedId}`, vendorU.token, { description: "Fixed it" });
    check("rejected item: edit -> pending (resubmitted), never approved", resub.status === 200 && resub.body.data.status === "pending", resub.body);
  }

  // ------------------------------------------------------------ availability
  section("6. Availability (active / inactive)");
  {
    const vendorV = await makeUser("vendorV", "vendor");
    const x = await seedItem(vendorV.id, "approved", "X approved");
    const r = await seedItem(vendorV.id, "rejected", "R rejected");
    const p = await seedItem(vendorV.id, "pending", "P pending");
    const i = await seedItem(vendorV.id, "inactive", "I inactive");

    const off = await call("PATCH", `${BASE}/${x}/availability`, vendorV.token, { isActive: false });
    check("approved -> isActive:false -> 200 inactive", off.status === 200 && off.body.data.status === "inactive", off.body);
    check("DB status is inactive", (await dbItem(x))?.status === "inactive");
    check("hidden from public single", (await call("GET", `/api/menu-items/${x}`, null)).status === 404);
    const pubList = await call("GET", "/api/menu-items?limit=50", null);
    check("hidden from public list", !pubList.body.data.some((it: Json) => it._id === x.toHexString()));

    const offAgain = await call("PATCH", `${BASE}/${x}/availability`, vendorV.token, { isActive: false });
    check("deactivating twice is harmless (200, still inactive)", offAgain.status === 200 && offAgain.body.data.status === "inactive");

    const on = await call("PATCH", `${BASE}/${x}/availability`, vendorV.token, { isActive: true });
    check("inactive -> isActive:true -> 200 approved", on.status === 200 && on.body.data.status === "approved", on.body);
    check("visible on the public menu again", (await call("GET", `/api/menu-items/${x}`, null)).status === 200);

    // a vendor cannot approve anything
    const rejectedOn = await call("PATCH", `${BASE}/${r}/availability`, vendorV.token, { isActive: true });
    check("REJECTED item cannot be activated -> 409 INVALID_STATUS_TRANSITION", rejectedOn.status === 409 && rejectedOn.body.code === "INVALID_STATUS_TRANSITION", rejectedOn.body);
    const pendingOn = await call("PATCH", `${BASE}/${p}/availability`, vendorV.token, { isActive: true });
    check("PENDING item cannot be activated (self-approval) -> 409", pendingOn.status === 409 && pendingOn.body.code === "INVALID_STATUS_TRANSITION", pendingOn.body);
    check("pending can't be switched off -> 409", (await call("PATCH", `${BASE}/${p}/availability`, vendorV.token, { isActive: false })).status === 409);
    check("rejected can't be switched off -> 409", (await call("PATCH", `${BASE}/${r}/availability`, vendorV.token, { isActive: false })).status === 409);
    check("statuses of pending and rejected items are unchanged", (await dbItem(p))?.status === "pending" && (await dbItem(r))?.status === "rejected");

    const seededInactive = await call("PATCH", `${BASE}/${i}/availability`, vendorV.token, { isActive: true });
    check("a (seeded) inactive item can be re-activated while a slot is free", seededInactive.status === 200 && seededInactive.body.data.status === "approved", seededInactive.body);

    // inactive + edit must not skip approval
    await call("PATCH", `${BASE}/${x}/availability`, vendorV.token, { isActive: false });
    const editInactive = await call("PATCH", `${BASE}/${x}`, vendorV.token, { price: 777 });
    check("editing an inactive item -> pending (re-activating can't skip approval)", editInactive.status === 200 && editInactive.body.data.status === "pending", editInactive.body);
    const reactivate = await call("PATCH", `${BASE}/${x}/availability`, vendorV.token, { isActive: true });
    check("...and it can no longer be activated by the vendor -> 409", reactivate.status === 409, reactivate.body);

    const badBodies: [string, unknown][] = [
      ["empty object", {}], ["no body", undefined], ["isActive as string", { isActive: "yes" }], ["isActive null", { isActive: null }],
      ["status instead of isActive", { status: "approved" }], ["isActive + status", { isActive: true, status: "approved" }],
    ];
    for (const [label, body] of badBodies) {
      const res = await call("PATCH", `${BASE}/${x}/availability`, vendorV.token, body);
      check(`availability with ${label} -> 400`, res.status === 400, res.body);
    }
    check("availability invalid id -> 400", (await call("PATCH", `${BASE}/INVALID_ID/availability`, vendorV.token, { isActive: true })).status === 400);
    check("availability unknown id -> 404", (await call("PATCH", `${BASE}/${new ObjectId()}/availability`, vendorV.token, { isActive: true })).status === 404);
  }

  // ------------------------------------------------------------ free limit
  section("7. Free plan: at most 3 active (pending + approved) items");
  {
    const vendorF = await makeUser("vendorF", "vendor");
    const ids: string[] = [];

    for (let n = 1; n <= 3; n++) {
      const r = await call("POST", BASE, vendorF.token, validBody(`Free ${n}`));
      ids.push(r.body.data?._id);
      check(`item ${n} of 3 -> 201`, r.status === 201, r.body);
    }

    const fourth = await call("POST", BASE, vendorF.token, validBody("Free 4"));
    check("4th item -> 403 FREE_PLAN_LIMIT_REACHED", fourth.status === 403 && fourth.body.code === "FREE_PLAN_LIMIT_REACHED", fourth.body);
    check("nothing was stored for it", (await activeCount(vendorF.id)) === 3 && (await totalCount(vendorF.id)) === 3);

    // rejected / inactive don't count, but they can't come back above the limit
    const rej = await seedItem(vendorF.id, "rejected");
    const ina = await seedItem(vendorF.id, "inactive");
    check("rejected + inactive items do not count towards the limit", (await activeCount(vendorF.id)) === 3);
    check("still no room for a new item", (await call("POST", BASE, vendorF.token, validBody("Free 4b"))).status === 403);
    const react = await call("PATCH", `${BASE}/${ina}/availability`, vendorF.token, { isActive: true });
    check("at the limit: re-activating an inactive item -> 403", react.status === 403 && react.body.code === "FREE_PLAN_LIMIT_REACHED", react.body);
    const resub = await call("PATCH", `${BASE}/${rej}`, vendorF.token, { price: 123 });
    check("at the limit: resubmitting a rejected item -> 403", resub.status === 403 && resub.body.code === "FREE_PLAN_LIMIT_REACHED", resub.body);
    check("both stayed as they were", (await dbItem(ina))?.status === "inactive" && (await dbItem(rej))?.status === "rejected");

    const editPending = await call("PATCH", `${BASE}/${ids[0]}`, vendorF.token, { price: 999 });
    check("at the limit: editing a pending item is fine (200)", editPending.status === 200, editPending.body);
    await setStatus(new ObjectId(ids[1]), "approved");
    const editApproved = await call("PATCH", `${BASE}/${ids[1]}`, vendorF.token, { price: 999 });
    check("at the limit: editing an approved item is fine (200, back to pending)", editApproved.status === 200 && editApproved.body.data.status === "pending", editApproved.body);

    // freeing a slot
    await setStatus(new ObjectId(ids[1]), "approved");
    const deact = await call("PATCH", `${BASE}/${ids[1]}/availability`, vendorF.token, { isActive: false });
    check("switching an item off frees a slot", deact.status === 200 && (await activeCount(vendorF.id)) === 2);
    const create5 = await call("POST", BASE, vendorF.token, validBody("Free 5"));
    check("now a new item fits again -> 201", create5.status === 201, create5.body);
    const back = await call("PATCH", `${BASE}/${ids[1]}/availability`, vendorF.token, { isActive: true });
    check("...but then the switched-off item cannot come back -> 403", back.status === 403 && back.body.code === "FREE_PLAN_LIMIT_REACHED", back.body);

    const del = await call("DELETE", `${BASE}/${create5.body.data._id}`, vendorF.token);
    check("deleting an item frees a slot", del.status === 200 && (await activeCount(vendorF.id)) === 2);
    check("so the switched-off item can come back now -> 200", (await call("PATCH", `${BASE}/${ids[1]}/availability`, vendorF.token, { isActive: true })).status === 200);
    check("the limit is per vendor: vendorB is unaffected", (await call("POST", BASE, vendorB.token, validBody("B item"))).status === 201);
  }

  // ------------------------------------------------------------ race conditions
  section("8. Race conditions (parallel requests)");
  {
    const vendorR = await makeUser("vendorR", "vendor");
    const results = await Promise.all(Array.from({ length: 10 }, (_, n) => call("POST", BASE, vendorR.token, validBody(`Race ${n}`))));
    const created = results.filter((r) => r.status === 201).length;
    const denied = results.filter((r) => r.status === 403 && r.body.code === "FREE_PLAN_LIMIT_REACHED").length;
    check("10 parallel creates on the Free plan: exactly 3 succeed", created === 3, results.map((r) => r.status));
    check("...the other 7 are refused with FREE_PLAN_LIMIT_REACHED", denied === 7, results.map((r) => r.status));
    check("...and the database holds exactly 3", (await totalCount(vendorR.id)) === 3);

    const vendorS = await makeUser("vendorS", "vendor");
    const inactiveIds = await Promise.all(Array.from({ length: 6 }, () => seedItem(vendorS.id, "inactive")));
    const acts = await Promise.all(inactiveIds.map((id) => call("PATCH", `${BASE}/${id}/availability`, vendorS.token, { isActive: true })));
    check("6 parallel activations on the Free plan: exactly 3 succeed", acts.filter((r) => r.status === 200).length === 3, acts.map((r) => r.status));
    check("...the rest -> 403 FREE_PLAN_LIMIT_REACHED", acts.filter((r) => r.status === 403 && r.body.code === "FREE_PLAN_LIMIT_REACHED").length === 3);
    check("...and exactly 3 are approved in the database", (await menuItemsCollection().countDocuments({ vendorId: vendorS.id, status: "approved" })) === 3);

    const vendorM = await makeUser("vendorM", "vendor");
    const mixedInactive = await Promise.all(Array.from({ length: 3 }, () => seedItem(vendorM.id, "inactive")));
    const mixed = await Promise.all([
      ...Array.from({ length: 3 }, (_, n) => call("POST", BASE, vendorM.token, validBody(`Mixed ${n}`))),
      ...mixedInactive.map((id) => call("PATCH", `${BASE}/${id}/availability`, vendorM.token, { isActive: true })),
    ]);
    check("creates and activations mixed in parallel: never more than 3 active", (await activeCount(vendorM.id)) === 3, mixed.map((r) => r.status));
    check("no request failed with a server error", mixed.every((r) => r.status < 500) && acts.every((r) => r.status < 500) && results.every((r) => r.status < 500));
  }

  // ------------------------------------------------------------ premium
  section("9. Premium plan, expiry");
  {
    const vendorP = await makeUser("vendorP", "vendor");
    await setPlan(vendorP, "premium", future());
    const made = await Promise.all(Array.from({ length: 6 }, (_, n) => call("POST", BASE, vendorP.token, validBody(`Premium ${n}`))));
    check("active Premium: 6 items -> all 201 (no limit)", made.every((r) => r.status === 201), made.map((r) => r.status));
    const ina = await seedItem(vendorP.id, "inactive");
    check("active Premium can activate beyond 3", (await call("PATCH", `${BASE}/${ina}/availability`, vendorP.token, { isActive: true })).status === 200);

    const vendorE = await makeUser("vendorE", "vendor");
    await setPlan(vendorE, "premium", past());
    const e = [];
    for (let n = 1; n <= 4; n++) e.push((await call("POST", BASE, vendorE.token, validBody(`Expired ${n}`))).status);
    check("EXPIRED Premium follows the Free rule: 201, 201, 201, then 403", e.join() === "201,201,201,403", e);

    const vendorN = await makeUser("vendorN", "vendor");
    await setPlan(vendorN, "premium", null);
    const nn = [];
    for (let n = 1; n <= 4; n++) nn.push((await call("POST", BASE, vendorN.token, validBody(`NoExpiry ${n}`))).status);
    check("Premium with no expiry date is treated as Free (4th -> 403)", nn.join() === "201,201,201,403", nn);

    const vendorQ = await makeUser("vendorQ", "vendor");
    await setPlan(vendorQ, "free", future());
    const q = [];
    for (let n = 1; n <= 4; n++) q.push((await call("POST", BASE, vendorQ.token, validBody(`FreeWithDate ${n}`))).status);
    check("plan 'free' with a future date is still Free (4th -> 403)", q.join() === "201,201,201,403", q);

    // the plan is read from the database on every request
    const vendorT = await makeUser("vendorT", "vendor");
    await setPlan(vendorT, "premium", future());
    for (let n = 1; n <= 4; n++) await call("POST", BASE, vendorT.token, validBody(`Toggle ${n}`));
    check("(setup) Premium vendor holds 4 items", (await activeCount(vendorT.id)) === 4);
    await setPlan(vendorT, "premium", past());
    const lapsed = await call("POST", BASE, vendorT.token, validBody("Toggle 5"));
    check("subscription expires -> same token, next create -> 403", lapsed.status === 403 && lapsed.body.code === "FREE_PLAN_LIMIT_REACHED", lapsed.body);
    check("existing items are kept (nothing deleted)", (await activeCount(vendorT.id)) === 4);
    await setPlan(vendorT, "premium", future());
    check("subscription renewed -> create works again", (await call("POST", BASE, vendorT.token, validBody("Toggle 6"))).status === 201);
  }

  // ------------------------------------------------------------ delete
  section("10. Delete");
  {
    const vendorD = await makeUser("vendorD", "vendor");
    const created = await call("POST", BASE, vendorD.token, validBody("To delete"));
    const id: string = created.body.data._id;

    const del = await call("DELETE", `${BASE}/${id}`, vendorD.token);
    check("own item -> 200, success, message", del.status === 200 && del.body.success === true && del.body.data._id === id, del.body);
    check("gone from the database", (await dbItem(id)) === null);
    check("deleting it again -> 404", (await call("DELETE", `${BASE}/${id}`, vendorD.token)).status === 404);
    check("invalid id -> 400", (await call("DELETE", `${BASE}/INVALID_ID`, vendorD.token)).status === 400);
    check("unknown id -> 404", (await call("DELETE", `${BASE}/${new ObjectId()}`, vendorD.token)).status === 404);

    const keep = await seedItem(vendorB.id, "approved", "B keeps this");
    check("another vendor's item -> 404 and it survives", (await call("DELETE", `${BASE}/${keep}`, vendorD.token)).status === 404 && (await dbItem(keep)) !== null);

    // open orders block deletion
    const ordered = await seedItem(vendorD.id, "approved", "Has an order");
    const order = buildOrder({ itemId: ordered, vendorId: vendorD.id, customerId: customer.id, deliveryDate: "2099-01-01", deliveryAddress: "Somewhere 1" });
    const { insertedId: orderId } = await ordersCollection().insertOne(order as never);
    const blocked409 = await call("DELETE", `${BASE}/${ordered}`, vendorD.token);
    check("item with an open (pending) order -> 409 ITEM_HAS_OPEN_ORDERS", blocked409.status === 409 && blocked409.body.code === "ITEM_HAS_OPEN_ORDERS", blocked409.body);
    check("...and it was not deleted", (await dbItem(ordered)) !== null);
    await ordersCollection().updateOne({ _id: orderId }, { $set: { status: "cancelled" } });
    check("after the order is cancelled it can be deleted -> 200", (await call("DELETE", `${BASE}/${ordered}`, vendorD.token)).status === 200);
  }

  // ------------------------------------------------------------ regression
  section("11. Public API and the rest of the app are unchanged");
  {
    const pub = await call("GET", "/api/menu-items?limit=50", null);
    const approvedInDb = await menuItemsCollection().countDocuments({ status: "approved" });
    check("public list total = approved items in the database", pub.status === 200 && pub.body.pagination.totalItems === approvedInDb, { api: pub.body.pagination?.totalItems, db: approvedInDb });
    check("public items still hide vendorId/status", pub.body.data.every((it: Json) => !("vendorId" in it) && !("status" in it)));
    check("public categories still 200", (await call("GET", "/api/categories", null)).status === 200);
    check("public featured still 200", (await call("GET", "/api/menu-items/featured", null)).status === 200);
    check("/api/health still 200", (await call("GET", "/api/health", null)).status === 200);
    check("unknown route still 404 JSON", (await call("GET", "/api/vendor/nope", null)).body.success === false);
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
