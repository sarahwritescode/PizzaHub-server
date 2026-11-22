/**
 * Checks the customer order API end to end over real HTTP: `npm run verify:customer-orders`.
 *
 * Real sign-up, real Better Auth JWTs, real MongoDB. It never touches your real data: DB_NAME is
 * switched to a throwaway database (pizzahub_orders_verify_<timestamp>) BEFORE the app is loaded,
 * and that database is dropped at the end.
 *
 * Users come from the real sign-up; the admin and the blocked flag are set directly in the
 * throwaway database. Menu items are inserted directly so every status exists, and an order is
 * moved to "accepted" directly (there is no vendor order API yet).
 */
process.env.DB_NAME = `pizzahub_orders_verify_${Date.now()}`;

const { ObjectId } = await import("mongodb");
const { default: app } = await import("../app.js");
const { env } = await import("../config/env.js");
const { client, connectDB, getDB } = await import("../config/db.js");
const { initializeDatabase } = await import("../config/initDatabase.js");
const { menuItemsCollection, ordersCollection, usersCollection } = await import("../models/index.js");

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

const BASE = "/api/orders";

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

const seedItem = async (vendorId: Id, status: Status, itemName: string) => {
  const { insertedId } = await menuItemsCollection().insertOne({
    vendorId,
    itemName,
    category: "Pizza",
    description: "Inserted by the test",
    price: 450,
    location: "Dhaka",
    images: ["https://example.com/seed.jpg"],
    status,
    createdAt: new Date(),
  } as never);
  return insertedId;
};

const dbOrder = (id: string | Id) => ordersCollection().findOne({ _id: new ObjectId(String(id)) });
const orderCount = (filter: object = {}) => ordersCollection().countDocuments(filter);

const body = (itemId: Id | string, over: Record<string, unknown> = {}) => ({
  itemId: String(itemId),
  deliveryDate: "2099-01-01",
  deliveryAddress: "House 1, Road 2, Dhaka",
  message: "Extra cheese please",
  ...over,
});

const ORDER_FIELDS = "_id,createdAt,deliveryAddress,deliveryDate,item,itemId,message,status,vendor";
const todayUtc = () => new Date().toISOString().slice(0, 10);

const server = app.listen(0);

try {
  await connectDB();
  const initReport = await initializeDatabase();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  section("Setting up real users (sign-up + JWT)");
  const [vendor, vendor2, cust1, cust2, admin, blocked, selfOwner] = await Promise.all([
    makeUser("vendor", "vendor"),
    makeUser("vendortwo", "vendor"),
    makeUser("cust1", "customer"),
    makeUser("cust2", "customer"),
    makeUser("admin", "customer"),
    makeUser("blockedcust", "customer"),
    makeUser("selfowner", "vendor"),
  ]);
  await usersCollection().updateOne({ _id: admin.id }, { $set: { role: "admin" } });
  await usersCollection().updateOne({ _id: blocked.id }, { $set: { isBlocked: true } });
  await usersCollection().updateOne({ _id: vendor.id }, { $set: { businessName: "Pizza Palace" } });
  // selfOwner owns an item and is a customer now (a role can change): they must not order it.
  await usersCollection().updateOne({ _id: selfOwner.id }, { $set: { role: "customer" } });
  check("7 users created with tokens", [vendor, vendor2, cust1, cust2, admin, blocked, selfOwner].every((u) => u.token.length > 20));
  check("database init had no index problems", initReport.problems.length === 0, initReport.problems);

  const approved = await seedItem(vendor.id, "approved", "Approved Pizza");
  const approved2 = await seedItem(vendor2.id, "approved", "Second Vendor Pizza");
  const pendingItem = await seedItem(vendor.id, "pending", "Pending Pizza");
  const rejectedItem = await seedItem(vendor.id, "rejected", "Rejected Pizza");
  const inactiveItem = await seedItem(vendor.id, "inactive", "Inactive Pizza");
  const ownItem = await seedItem(selfOwner.id, "approved", "Own Pizza");

  // ------------------------------------------------------------ index
  section("0. The duplicate-order index");
  {
    const index = (await getDB().collection("orders").indexes()).find((i) => i.name === "orders_active_customer_item_date_uidx");
    check("unique partial index on {itemId, customerId, deliveryDate} exists", Boolean(index?.unique) && JSON.stringify(index?.key) === '{"itemId":1,"customerId":1,"deliveryDate":1}', index);
    check("...limited to pending + accepted orders", JSON.stringify(index?.partialFilterExpression) === '{"status":{"$in":["pending","accepted"]}}', index?.partialFilterExpression);
    // Straight into MongoDB, bypassing the API and its look-up: the index alone must refuse the duplicate.
    const raw = (status: string) => ({ itemId: approved, vendorId: vendor.id, customerId: cust1.id, deliveryDate: new Date("2098-01-01T00:00:00Z"), deliveryAddress: "Raw", status, createdAt: new Date() });
    const first = await ordersCollection().insertOne(raw("pending") as never);
    const dupe = await ordersCollection().insertOne(raw("accepted") as never).then(() => null, (error: { code?: number }) => error);
    check("MongoDB itself refuses a 2nd active order for the same customer, item and day (E11000)", dupe?.code === 11000, dupe);
    check("...but accepts it once the first is cancelled (partial index)", await (async () => {
      await ordersCollection().updateOne({ _id: first.insertedId }, { $set: { status: "cancelled" } });
      const ok = await ordersCollection().insertOne(raw("pending") as never).then(() => true, () => false);
      await ordersCollection().deleteMany({ deliveryDate: new Date("2098-01-01T00:00:00Z") });
      return ok;
    })());
    const again = await initializeDatabase();
    check("running init again changes nothing and reports no problem", again.indexesCreated.length === 0 && again.problems.length === 0, again);
  }

  // ------------------------------------------------------------ access
  section("1. Who may order (every endpoint)");
  {
    const probes: [string, string, unknown][] = [
      ["POST", BASE, body(approved)],
      ["GET", `${BASE}/my-orders`, undefined],
      ["GET", `${BASE}/${new ObjectId()}`, undefined],
      ["PATCH", `${BASE}/${new ObjectId()}/cancel`, undefined],
    ];

    for (const [method, path, payload] of probes) {
      const label = `${method} ${path.replace(/[0-9a-f]{24}/, ":id")}`;
      const anon = await call(method, path, null, payload);
      check(`${label} without login -> 401 NO_CREDENTIALS`, anon.status === 401 && anon.body.code === "NO_CREDENTIALS", anon.body);
      const vend = await call(method, path, vendor.token, payload);
      check(`${label} as vendor -> 403 FORBIDDEN`, vend.status === 403 && vend.body.code === "FORBIDDEN", vend.body);
      const adm = await call(method, path, admin.token, payload);
      check(`${label} as admin -> 403 FORBIDDEN`, adm.status === 403 && adm.body.code === "FORBIDDEN", adm.body);
      const blk = await call(method, path, blocked.token, payload);
      check(`${label} as blocked customer -> 403 ACCOUNT_BLOCKED`, blk.status === 403 && blk.body.code === "ACCOUNT_BLOCKED", blk.body);
    }

    check("bad token -> 401 INVALID_TOKEN", (await call("GET", `${BASE}/my-orders`, "not.a.jwt")).body.code === "INVALID_TOKEN");
    check("none of those requests created an order", (await orderCount()) === 0);

    const cookieOk = await fetch(baseUrl + `${BASE}/my-orders`, { headers: { cookie: cust1.cookie } });
    check("customer session cookie also works (GET) -> 200", cookieOk.status === 200);
    const csrf = await fetch(baseUrl + BASE, {
      method: "POST",
      headers: { cookie: cust1.cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify(body(approved)),
    });
    check("cookie POST from a foreign Origin -> 403 (CSRF guard), no order", csrf.status === 403 && (await orderCount()) === 0);
  }

  // ------------------------------------------------------------ create
  section("2. Create an order");
  let firstOrderId = "";
  {
    const res = await call("POST", BASE, cust1.token, body(approved));
    firstOrderId = res.body.data?._id;
    check("customer orders an approved item -> 201 success, message set", res.status === 201 && res.body.success === true && typeof res.body.message === "string", res.body);
    check("status is pending", res.body.data.status === "pending");
    check("response fields: " + ORDER_FIELDS, Object.keys(res.body.data).sort().join() === ORDER_FIELDS, Object.keys(res.body.data));
    check("deliveryDate is the day at 00:00 UTC", res.body.data.deliveryDate === "2099-01-01T00:00:00.000Z", res.body.data.deliveryDate);
    check("item display info: _id, itemName, category, price, location, images", Object.keys(res.body.data.item).sort().join() === "_id,category,images,itemName,location,price" && res.body.data.item.itemName === "Approved Pizza", res.body.data.item);
    check("vendor display info is only _id, name, businessName", Object.keys(res.body.data.vendor).sort().join() === "_id,businessName,name" && res.body.data.vendor.businessName === "Pizza Palace", res.body.data.vendor);
    check("response has no customerId / vendorId / email", !("customerId" in res.body.data) && !("vendorId" in res.body.data) && !("email" in res.body.data.vendor));

    const doc = await dbOrder(firstOrderId);
    check("stored: customerId = the caller, vendorId = the item's vendor, status pending", doc!.customerId.equals(cust1.id) && doc!.vendorId.equals(vendor.id) && doc!.status === "pending", doc);
    check("stored: itemId, address and message as sent (trimmed)", doc!.itemId.equals(approved) && doc!.deliveryAddress === "House 1, Road 2, Dhaka" && doc!.message === "Extra cheese please");
    check("stored deliveryDate is a real Date", doc!.deliveryDate instanceof Date);

    const noMessage = await call("POST", BASE, cust1.token, body(approved2, { message: undefined, deliveryDate: "2099-02-01" }));
    check("message is optional -> 201, response has no message", noMessage.status === 201 && !("message" in noMessage.body.data), noMessage.body);
    const blankMessage = await call("POST", BASE, cust1.token, body(approved2, { message: "   ", deliveryDate: "2099-02-02" }));
    check("a blank message counts as none -> 201", blankMessage.status === 201 && !("message" in blankMessage.body.data), blankMessage.body);
    const today = await call("POST", BASE, cust1.token, body(approved2, { deliveryDate: todayUtc() }));
    check("today is a valid delivery date -> 201", today.status === 201, today.body);
    const trimmed = await call("POST", BASE, cust1.token, body(approved2, { deliveryDate: "2099-02-03", deliveryAddress: "  Padded address  " }));
    check("address is trimmed", trimmed.status === 201 && trimmed.body.data.deliveryAddress === "Padded address", trimmed.body);
  }

  section("3. Items that cannot be ordered");
  {
    const before = await orderCount();
    const missing = await call("POST", BASE, cust2.token, body(new ObjectId()));
    check("item that does not exist -> 404 MENU_ITEM_NOT_FOUND", missing.status === 404 && missing.body.code === "MENU_ITEM_NOT_FOUND", missing.body);

    for (const [label, id] of [["pending", pendingItem], ["rejected", rejectedItem], ["inactive", inactiveItem]] as const) {
      const r = await call("POST", BASE, cust2.token, body(id));
      check(`${label} item -> 409 MENU_ITEM_UNAVAILABLE`, r.status === 409 && r.body.code === "MENU_ITEM_UNAVAILABLE", r.body);
      check(`...the message does not reveal the status "${label}"`, !r.body.message.toLowerCase().includes(label), r.body.message);
    }

    const own = await call("POST", BASE, selfOwner.token, body(ownItem));
    check("your own item (you are its vendor) -> 403 CANNOT_ORDER_OWN_ITEM", own.status === 403 && own.body.code === "CANNOT_ORDER_OWN_ITEM", own.body);
    check("none of those created an order", (await orderCount()) === before);
  }

  section("4. Duplicates (same customer, same item, same day)");
  {
    const dup = await call("POST", BASE, cust1.token, body(approved));
    check("same item, same day again -> 409 DUPLICATE_ORDER", dup.status === 409 && dup.body.code === "DUPLICATE_ORDER", dup.body);
    const dupOtherAddress = await call("POST", BASE, cust1.token, body(approved, { deliveryAddress: "Somewhere else", message: "other" }));
    check("...even with another address or message -> 409", dupOtherAddress.status === 409 && dupOtherAddress.body.code === "DUPLICATE_ORDER");
    check("only one order exists for it", (await orderCount({ itemId: approved, customerId: cust1.id, deliveryDate: new Date("2099-01-01T00:00:00Z") })) === 1);

    check("same item, another day -> 201", (await call("POST", BASE, cust1.token, body(approved, { deliveryDate: "2099-01-02" }))).status === 201);
    check("another item, same day -> 201", (await call("POST", BASE, cust1.token, body(approved2))).status === 201);
    check("another customer, same item and day -> 201", (await call("POST", BASE, cust2.token, body(approved))).status === 201);

    // two identical requests at the same moment: the unique index lets exactly one in
    const racing = body(approved, { deliveryDate: "2099-03-03" });
    const results = await Promise.all(Array.from({ length: 6 }, () => call("POST", BASE, cust1.token, racing)));
    const created = results.filter((r) => r.status === 201).length;
    const refused = results.filter((r) => r.status === 409 && r.body.code === "DUPLICATE_ORDER").length;
    check("6 identical requests at the same moment -> exactly 1 created, 5 DUPLICATE_ORDER", created === 1 && refused === 5, results.map((r) => r.status));
    check("...and exactly one order is stored", (await orderCount({ itemId: approved, customerId: cust1.id, deliveryDate: new Date("2099-03-03T00:00:00Z") })) === 1);

    // a finished order frees the day: cancel, then order again
    const first = await call("POST", BASE, cust2.token, body(approved2, { deliveryDate: "2099-04-04" }));
    check("setup: order for 2099-04-04", first.status === 201);
    check("duplicate while it is pending -> 409", (await call("POST", BASE, cust2.token, body(approved2, { deliveryDate: "2099-04-04" }))).status === 409);
    check("cancel it -> 200", (await call("PATCH", `${BASE}/${first.body.data._id}/cancel`, cust2.token)).status === 200);
    const reorder = await call("POST", BASE, cust2.token, body(approved2, { deliveryDate: "2099-04-04" }));
    check("after cancelling, the same item and day can be ordered again -> 201", reorder.status === 201, reorder.body);
    await ordersCollection().updateOne({ _id: new ObjectId(reorder.body.data._id) }, { $set: { status: "accepted" } });
    check("an ACCEPTED order still blocks a duplicate -> 409", (await call("POST", BASE, cust2.token, body(approved2, { deliveryDate: "2099-04-04" }))).status === 409);
    await ordersCollection().updateOne({ _id: new ObjectId(reorder.body.data._id) }, { $set: { status: "rejected" } });
    check("after a vendor rejects it, the day is free again -> 201", (await call("POST", BASE, cust2.token, body(approved2, { deliveryDate: "2099-04-04" }))).status === 201);
  }

  section("5. Invalid input");
  {
    const before = await orderCount();
    const bad = async (label: string, payload: unknown, field?: string) => {
      const r = await call("POST", BASE, cust1.token, payload);
      check(`${label} -> 400 VALIDATION_ERROR${field ? ` on "${field}"` : ""}`, r.status === 400 && r.body.code === "VALIDATION_ERROR" && Array.isArray(r.body.errors) && (!field || r.body.errors.some((e: Json) => e.field === field)), r.body);
    };

    await bad("itemId 'not-an-id'", body("not-an-id"), "itemId");
    await bad("itemId too short", body("507f1f77bcf86cd79943901"), "itemId");
    await bad("itemId not hex", body("zzzzzzzzzzzzzzzzzzzzzzzz"), "itemId");
    await bad("itemId missing", { ...body(approved), itemId: undefined }, "itemId");
    await bad("itemId a number", body(approved, { itemId: 123 }), "itemId");
    await bad("deliveryDate missing", body(approved, { deliveryDate: undefined }), "deliveryDate");
    await bad("deliveryDate 'not-a-date'", body(approved, { deliveryDate: "not-a-date" }), "deliveryDate");
    await bad("deliveryDate 2099-02-30 (no such day)", body(approved, { deliveryDate: "2099-02-30" }), "deliveryDate");
    await bad("deliveryDate 2099-13-01", body(approved, { deliveryDate: "2099-13-01" }), "deliveryDate");
    await bad("deliveryDate 01-12-2099 (wrong format)", body(approved, { deliveryDate: "01-12-2099" }), "deliveryDate");
    await bad("deliveryDate with a time", body(approved, { deliveryDate: "2099-01-01T10:00:00Z" }), "deliveryDate");
    await bad("deliveryDate a number", body(approved, { deliveryDate: 20990101 }), "deliveryDate");
    await bad("deliveryDate null", body(approved, { deliveryDate: null }), "deliveryDate");
    await bad("deliveryDate in the past", body(approved, { deliveryDate: "2020-01-01" }), "deliveryDate");
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    await bad("deliveryDate yesterday", body(approved, { deliveryDate: yesterday }), "deliveryDate");
    await bad("deliveryAddress missing", body(approved, { deliveryAddress: undefined }), "deliveryAddress");
    await bad("deliveryAddress blank", body(approved, { deliveryAddress: "   " }), "deliveryAddress");
    await bad("deliveryAddress over 300 characters", body(approved, { deliveryAddress: "x".repeat(301) }), "deliveryAddress");
    await bad("deliveryAddress a number", body(approved, { deliveryAddress: 5 }), "deliveryAddress");
    await bad("message over 500 characters", body(approved, { message: "x".repeat(501) }), "message");
    await bad("message a number", body(approved, { message: 5 }), "message");
    await bad("empty body {}", {});
    await bad("body is an array", []);

    const noBody = await call("POST", BASE, cust1.token);
    check("no body at all -> 400 VALIDATION_ERROR", noBody.status === 400 && noBody.body.code === "VALIDATION_ERROR", noBody.body);
    const brokenJson = await call("POST", BASE, cust1.token, "{ not json");
    check("broken JSON -> 400, not 500", brokenJson.status === 400 && brokenJson.body.success === false, brokenJson.body);

    // mass assignment: the client cannot set who, what state, or when
    for (const field of [
      { customerId: String(cust2.id) },
      { vendorId: String(vendor2.id) },
      { status: "accepted" },
      { createdAt: "2000-01-01T00:00:00Z" },
      { _id: String(new ObjectId()) },
      { price: 1 },
      { isAdmin: true },
    ]) {
      const key = Object.keys(field)[0]!;
      const r = await call("POST", BASE, cust1.token, body(approved, { deliveryDate: "2099-05-05", ...field }));
      check(`extra field "${key}" is refused -> 400 "This field is not allowed", nothing stored`, r.status === 400 && r.body.errors?.some((e: Json) => e.field === key), r.body);
    }
    check("no invalid request created an order", (await orderCount()) === before);
  }

  // ------------------------------------------------------------ list
  section("6. My orders: only mine, newest first, paginated");
  {
    await ordersCollection().deleteMany({});

    const ids: string[] = [];
    for (let day = 1; day <= 5; day++) {
      const r = await call("POST", BASE, cust1.token, body(approved, { deliveryDate: `2099-06-0${day}` }));
      ids.push(r.body.data._id);
      await new Promise((resolve) => setTimeout(resolve, 15)); // distinct createdAt
    }
    const others = await call("POST", BASE, cust2.token, body(approved, { deliveryDate: "2099-06-01" }));
    check("setup: 5 orders for customer 1, 1 for customer 2", ids.length === 5 && others.status === 201);

    const mine = await call("GET", `${BASE}/my-orders`, cust1.token);
    check("-> 200 success, message set", mine.status === 200 && mine.body.success === true && typeof mine.body.message === "string", mine.body);
    check("customer 1 sees exactly their 5 orders", mine.body.data.length === 5 && mine.body.pagination.totalItems === 5, mine.body.pagination);
    check("newest first", mine.body.data.map((o: Json) => o._id).join() === [...ids].reverse().join(), mine.body.data.map((o: Json) => o.deliveryDate));
    check("customer 2's order is not in customer 1's list", !mine.body.data.some((o: Json) => o._id === others.body.data._id));
    check("every order has item and vendor display info", mine.body.data.every((o: Json) => o.item?.itemName === "Approved Pizza" && o.vendor?.name === "vendor"));
    check("list items have the same fields as a created order", Object.keys(mine.body.data[0]).sort().join() === ORDER_FIELDS, Object.keys(mine.body.data[0]));
    check("nobody's email / customerId / vendorId appears anywhere in the list", !JSON.stringify(mine.body).match(/@pizzahub\.test|customerId|vendorId/));

    const theirs = await call("GET", `${BASE}/my-orders`, cust2.token);
    check("customer 2 sees only their own 1 order", theirs.body.data.length === 1 && theirs.body.data[0]._id === others.body.data._id && theirs.body.pagination.totalItems === 1, theirs.body);
    const nobody = await call("GET", `${BASE}/my-orders`, selfOwner.token);
    check("a customer with no orders -> 200, data [], totalItems 0, totalPages 0", nobody.status === 200 && nobody.body.data.length === 0 && nobody.body.pagination.totalItems === 0 && nobody.body.pagination.totalPages === 0, nobody.body);

    const p1 = await call("GET", `${BASE}/my-orders?limit=2&page=1`, cust1.token);
    const p2 = await call("GET", `${BASE}/my-orders?limit=2&page=2`, cust1.token);
    const p3 = await call("GET", `${BASE}/my-orders?limit=2&page=3`, cust1.token);
    const p4 = await call("GET", `${BASE}/my-orders?limit=2&page=4`, cust1.token);
    check("limit=2: pages hold 2 / 2 / 1 / 0 orders, totalItems 5, totalPages 3", [p1, p2, p3, p4].map((p) => p.body.data.length).join() === "2,2,1,0" && p1.body.pagination.totalItems === 5 && p1.body.pagination.totalPages === 3, p1.body.pagination);
    check("hasNextPage / hasPreviousPage correct", p1.body.pagination.hasNextPage === true && p1.body.pagination.hasPreviousPage === false && p3.body.pagination.hasNextPage === false && p3.body.pagination.hasPreviousPage === true);
    check("pages together = all 5 orders once, newest first", [...p1.body.data, ...p2.body.data, ...p3.body.data].map((o: Json) => o._id).join() === [...ids].reverse().join());
    check("default limit is 12", mine.body.pagination.limit === 12 && mine.body.pagination.page === 1);

    for (const [qs, label] of [["page=0", "page 0"], ["page=abc", "page abc"], ["limit=51", "limit above max"], ["limit=-1", "negative limit"], ["limit=1.5", "fractional limit"], ["page=1&page=2", "repeated page"]] as const) {
      const r = await call("GET", `${BASE}/my-orders?${qs}`, cust1.token);
      check(`${label} -> 400 VALIDATION_ERROR`, r.status === 400 && r.body.code === "VALIDATION_ERROR", r.body);
    }

    // an order whose item or vendor is gone is still listed
    const orphanItem = await seedItem(new ObjectId(), "approved", "Orphan");
    const orphan = await call("POST", BASE, cust2.token, body(orphanItem, { deliveryDate: "2099-07-01" }));
    await menuItemsCollection().deleteOne({ _id: orphanItem });
    const afterDelete = await call("GET", `${BASE}/${orphan.body.data._id}`, cust2.token);
    check("an order whose item was deleted is still readable (item: null, vendor: null)", afterDelete.status === 200 && afterDelete.body.data.item === null && afterDelete.body.data.vendor === null, afterDelete.body);
  }

  // ------------------------------------------------------------ details
  section("7. Order details");
  {
    await ordersCollection().deleteMany({});
    const mineRes = await call("POST", BASE, cust1.token, body(approved));
    const orderId = mineRes.body.data._id;
    const otherRes = await call("POST", BASE, cust2.token, body(approved));
    const otherId = otherRes.body.data._id;

    const res = await call("GET", `${BASE}/${orderId}`, cust1.token);
    check("own order -> 200 success, data is the order", res.status === 200 && res.body.success === true && res.body.data._id === orderId, res.body);
    check("details have item and vendor display info", res.body.data.item.itemName === "Approved Pizza" && res.body.data.vendor.name === "vendor" && res.body.data.vendor.businessName === "Pizza Palace");
    check("same fields as a created order", Object.keys(res.body.data).sort().join() === ORDER_FIELDS);

    const stranger = await call("GET", `${BASE}/${otherId}`, cust1.token);
    check("another customer's order -> 404 ORDER_NOT_FOUND (same answer as a missing one)", stranger.status === 404 && stranger.body.code === "ORDER_NOT_FOUND", stranger.body);
    const missing = await call("GET", `${BASE}/${new ObjectId()}`, cust1.token);
    check("order that does not exist -> 404 ORDER_NOT_FOUND", missing.status === 404 && missing.body.code === "ORDER_NOT_FOUND" && missing.body.message === stranger.body.message, missing.body);

    for (const bad of ["not-an-id", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", "507f1f77bcf86cd79943901"]) {
      const r = await call("GET", `${BASE}/${bad}`, cust1.token);
      check(`id "${bad}" -> 400 VALIDATION_ERROR`, r.status === 400 && r.body.code === "VALIDATION_ERROR" && r.body.errors?.[0]?.field === "id", r.body);
    }
    check("'my-orders' is a route, not an id -> 200", (await call("GET", `${BASE}/my-orders`, cust1.token)).status === 200);
  }

  // ------------------------------------------------------------ cancel
  section("8. Cancel");
  {
    await ordersCollection().deleteMany({});
    const make = async (token: string, day: string) => (await call("POST", BASE, token, body(approved, { deliveryDate: day }))).body.data._id as string;

    const pending = await make(cust1.token, "2099-08-01");
    const res = await call("PATCH", `${BASE}/${pending}/cancel`, cust1.token);
    check("own pending order -> 200 success, message set", res.status === 200 && res.body.success === true && typeof res.body.message === "string", res.body);
    check("data.status is cancelled, same order, same fields", res.body.data._id === pending && res.body.data.status === "cancelled" && Object.keys(res.body.data).sort().join() === ORDER_FIELDS, res.body.data);
    check("stored status is cancelled, nothing else changed", (await dbOrder(pending))?.status === "cancelled" && (await dbOrder(pending))?.deliveryAddress === "House 1, Road 2, Dhaka");
    check("it shows as cancelled in the details", (await call("GET", `${BASE}/${pending}`, cust1.token)).body.data.status === "cancelled");

    const again = await call("PATCH", `${BASE}/${pending}/cancel`, cust1.token);
    check("cancelling again -> 409 INVALID_STATUS_TRANSITION 'already cancelled'", again.status === 409 && again.body.code === "INVALID_STATUS_TRANSITION" && /already cancelled/.test(again.body.message), again.body);

    for (const status of ["accepted", "rejected"] as const) {
      const id = await make(cust1.token, status === "accepted" ? "2099-08-02" : "2099-08-03");
      await ordersCollection().updateOne({ _id: new ObjectId(id) }, { $set: { status } });
      const r = await call("PATCH", `${BASE}/${id}/cancel`, cust1.token);
      check(`${status} order -> 409 INVALID_STATUS_TRANSITION, stays ${status}`, r.status === 409 && r.body.code === "INVALID_STATUS_TRANSITION" && (await dbOrder(id))?.status === status, r.body);
    }

    const others = await make(cust2.token, "2099-08-04");
    const steal = await call("PATCH", `${BASE}/${others}/cancel`, cust1.token);
    check("another customer's order -> 404 ORDER_NOT_FOUND, still pending", steal.status === 404 && steal.body.code === "ORDER_NOT_FOUND" && (await dbOrder(others))?.status === "pending", steal.body);

    const none = await call("PATCH", `${BASE}/${new ObjectId()}/cancel`, cust1.token);
    check("order that does not exist -> 404 ORDER_NOT_FOUND", none.status === 404 && none.body.code === "ORDER_NOT_FOUND", none.body);
    for (const bad of ["not-an-id", "123"]) {
      const r = await call("PATCH", `${BASE}/${bad}/cancel`, cust1.token);
      check(`id "${bad}" -> 400 VALIDATION_ERROR`, r.status === 400 && r.body.code === "VALIDATION_ERROR", r.body);
    }

    const withField = await make(cust1.token, "2099-08-05");
    const extra = await call("PATCH", `${BASE}/${withField}/cancel`, cust1.token, { status: "accepted" });
    check("a body field is refused -> 400, order untouched", extra.status === 400 && extra.body.code === "VALIDATION_ERROR" && (await dbOrder(withField))?.status === "pending", extra.body);
    const emptyObj = await call("PATCH", `${BASE}/${withField}/cancel`, cust1.token, {});
    check("an empty JSON body {} is fine -> 200", emptyObj.status === 200, emptyObj.body);

    // concurrency
    const race = await make(cust1.token, "2099-08-06");
    const cancels = await Promise.all(Array.from({ length: 5 }, () => call("PATCH", `${BASE}/${race}/cancel`, cust1.token)));
    check("5 cancels at the same moment -> exactly one 200, four 409", cancels.filter((r) => r.status === 200).length === 1 && cancels.filter((r) => r.status === 409).length === 4, cancels.map((r) => r.status));

    const vsAccept = await make(cust1.token, "2099-08-07");
    const [cancelRes] = await Promise.all([
      call("PATCH", `${BASE}/${vsAccept}/cancel`, cust1.token),
      // a vendor accepting at the same moment (done as the same atomic "only if pending" write the vendor API will use)
      ordersCollection().updateOne({ _id: new ObjectId(vsAccept), status: "pending" }, { $set: { status: "accepted" } }),
    ]);
    const finalStatus = (await dbOrder(vsAccept))?.status;
    check("cancel racing a vendor accept: one wins, never both", (cancelRes.status === 200 && finalStatus === "cancelled") || (cancelRes.status === 409 && finalStatus === "accepted"), { cancel: cancelRes.status, finalStatus });
  }

  // ------------------------------------------------------------ regression
  section("9. Nothing else changed");
  {
    const pub = await call("GET", "/api/menu-items?limit=50", null);
    check("public menu: 200, only approved items, no vendorId/status", pub.status === 200 && pub.body.data.length === 3 && pub.body.data.every((i: Json) => !("vendorId" in i) && !("status" in i)), pub.body.pagination);
    check("public categories / featured / health still 200", (await call("GET", "/api/categories", null)).status === 200 && (await call("GET", "/api/menu-items/featured", null)).status === 200 && (await call("GET", "/api/health", null)).status === 200);
    check("vendor menu list still 200 for a vendor, 403 for a customer", (await call("GET", "/api/vendor/menu-items", vendor.token)).status === 200 && (await call("GET", "/api/vendor/menu-items", cust1.token)).status === 403);
    check("admin menu list still 200 for an admin", (await call("GET", "/api/admin/menu-items", admin.token)).status === 200);
    check("unknown route still 404 JSON", (await call("GET", "/api/orders/x/y/z", cust1.token)).body.success === false);

    // open orders still block the vendor's delete (existing rule), now with an order made through the API
    const target = await seedItem(vendor.id, "approved", "Has an API order");
    const order = await call("POST", BASE, cust1.token, body(target, { deliveryDate: "2099-09-09" }));
    const blockedDelete = await call("DELETE", `/api/vendor/menu-items/${target}`, vendor.token);
    check("an order created through the API blocks the vendor's delete (409 ITEM_HAS_OPEN_ORDERS)", blockedDelete.status === 409 && blockedDelete.body.code === "ITEM_HAS_OPEN_ORDERS", blockedDelete.body);
    await call("PATCH", `${BASE}/${order.body.data._id}/cancel`, cust1.token);
    check("after the customer cancels it, the vendor can delete the item -> 200", (await call("DELETE", `/api/vendor/menu-items/${target}`, vendor.token)).status === 200);
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
