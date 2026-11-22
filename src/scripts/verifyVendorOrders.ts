/**
 * Checks the vendor order API end to end over real HTTP: `npm run verify:vendor-orders`.
 *
 * Real sign-up, real Better Auth JWTs, real MongoDB. It never touches your real data: DB_NAME is
 * switched to a throwaway database (pizzahub_vorders_verify_<timestamp>) BEFORE the app is loaded,
 * and that database is dropped at the end.
 *
 * Orders are placed through the real customer API (POST /api/orders). Only the admin, the blocked
 * flag and "cancelled" for one setup order are set directly in the throwaway database.
 */
process.env.DB_NAME = `pizzahub_vorders_verify_${Date.now()}`;

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

const BASE = "/api/vendor/orders";

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

const seedItem = async (vendorId: Id, itemName: string) => {
  const { insertedId } = await menuItemsCollection().insertOne({
    vendorId,
    itemName,
    category: "Pizza",
    description: "Inserted by the test",
    price: 450,
    location: "Dhaka",
    images: ["https://example.com/seed.jpg"],
    status: "approved",
    createdAt: new Date(),
  } as never);
  return insertedId;
};

let dayCounter = 0;
const nextDay = () => new Date(Date.UTC(2099, 0, 1) + ++dayCounter * 86_400_000).toISOString().slice(0, 10);

/** A real order through the real customer API. */
const placeOrder = async (customer: TestUser, itemId: Id, deliveryDate = nextDay(), message = "Extra cheese") => {
  const res = await call("POST", "/api/orders", customer.token, { itemId: String(itemId), deliveryDate, deliveryAddress: "House 1, Road 2, Dhaka", message });
  if (res.status !== 201) throw new Error(`could not place an order: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.data._id as string, deliveryDate, order: res.body.data as Json };
};

const dbStatus = async (id: string | Id) => (await ordersCollection().findOne({ _id: new ObjectId(String(id)) }))?.status;

const VENDOR_ORDER_FIELDS = "_id,createdAt,customer,deliveryAddress,deliveryDate,item,itemId,message,status";
const CUSTOMER_ORDER_FIELDS = "_id,createdAt,deliveryAddress,deliveryDate,item,itemId,message,status,vendor";

const server = app.listen(0);

try {
  await connectDB();
  await initializeDatabase();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  section("Setting up real users (sign-up + JWT)");
  const [vendorA, vendorB, cust1, cust2, admin, blockedVendor] = await Promise.all([
    makeUser("vendora", "vendor"),
    makeUser("vendorb", "vendor"),
    makeUser("cust1", "customer"),
    makeUser("cust2", "customer"),
    makeUser("admin", "customer"),
    makeUser("blockedvendor", "vendor"),
  ]);
  await usersCollection().updateOne({ _id: admin.id }, { $set: { role: "admin" } });
  await usersCollection().updateOne({ _id: vendorA.id }, { $set: { businessName: "Vendor A Kitchen" } });
  check("6 users created with tokens", [vendorA, vendorB, cust1, cust2, admin, blockedVendor].every((u) => u.token.length > 20));

  const itemA = await seedItem(vendorA.id, "Pizza of A");
  const itemA2 = await seedItem(vendorA.id, "Second Pizza of A");
  const itemB = await seedItem(vendorB.id, "Pizza of B");
  const blockedItem = await seedItem(blockedVendor.id, "Pizza of the blocked vendor");
  const blockedOrder = await placeOrder(cust1, blockedItem); // placed BEFORE the vendor is blocked
  await usersCollection().updateOne({ _id: blockedVendor.id }, { $set: { isBlocked: true } });

  // ------------------------------------------------------------ access
  section("1. Access control (every endpoint)");
  {
    const probe = await placeOrder(cust1, itemA);
    const probes: [string, string][] = [
      ["GET", BASE],
      ["PATCH", `${BASE}/${probe.id}/accept`],
      ["PATCH", `${BASE}/${probe.id}/reject`],
    ];

    for (const [method, path] of probes) {
      const label = `${method} ${path.replace(/[0-9a-f]{24}/, ":id")}`;
      const anon = await call(method, path, null);
      check(`${label} without login -> 401 NO_CREDENTIALS`, anon.status === 401 && anon.body.code === "NO_CREDENTIALS", anon.body);
      const cust = await call(method, path, cust1.token);
      check(`${label} as customer -> 403 FORBIDDEN`, cust.status === 403 && cust.body.code === "FORBIDDEN", cust.body);
      const adm = await call(method, path, admin.token);
      check(`${label} as admin -> 403 FORBIDDEN`, adm.status === 403 && adm.body.code === "FORBIDDEN", adm.body);
      const blk = await call(method, method === "GET" ? path : `${BASE}/${blockedOrder.id}/${path.split("/").pop()}`, blockedVendor.token);
      check(`${label} as blocked vendor -> 403 ACCOUNT_BLOCKED`, blk.status === 403 && blk.body.code === "ACCOUNT_BLOCKED", blk.body);
    }

    check("bad token -> 401 INVALID_TOKEN", (await call("GET", BASE, "not.a.jwt")).body.code === "INVALID_TOKEN");
    check("the real order was never touched by those requests", (await dbStatus(probe.id)) === "pending" && (await dbStatus(blockedOrder.id)) === "pending");

    const cookieOk = await fetch(baseUrl + BASE, { headers: { cookie: vendorA.cookie } });
    check("vendor session cookie also works (GET) -> 200", cookieOk.status === 200);
    const csrf = await fetch(`${baseUrl}${BASE}/${probe.id}/accept`, { method: "PATCH", headers: { cookie: vendorA.cookie, origin: "https://evil.example" } });
    check("cookie PATCH from a foreign Origin -> 403 (CSRF guard), order untouched", csrf.status === 403 && (await dbStatus(probe.id)) === "pending");
    await ordersCollection().deleteMany({});
  }

  // ------------------------------------------------------------ list
  section("2. Vendor sees only their own orders");
  const mix: { id: string; status: string }[] = [];
  {
    const a1 = await placeOrder(cust1, itemA, nextDay(), "first");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const a2 = await placeOrder(cust2, itemA, nextDay(), "second");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const a3 = await placeOrder(cust1, itemA2, nextDay(), "third");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const b1 = await placeOrder(cust1, itemB, nextDay(), "belongs to B");

    const res = await call("GET", BASE, vendorA.token);
    check("-> 200 success, message set", res.status === 200 && res.body.success === true && typeof res.body.message === "string", res.body);
    check("vendor A sees exactly their 3 orders", res.body.data.length === 3 && res.body.pagination.totalItems === 3, res.body.pagination);
    check("newest first", res.body.data.map((o: Json) => o._id).join() === [a3.id, a2.id, a1.id].join(), res.body.data.map((o: Json) => o.message));
    check("vendor B's order is not in vendor A's list", !res.body.data.some((o: Json) => o._id === b1.id));

    const resB = await call("GET", BASE, vendorB.token);
    check("vendor B sees only their 1 order", resB.body.data.length === 1 && resB.body.data[0]._id === b1.id && resB.body.pagination.totalItems === 1, resB.body);

    const first = res.body.data[2];
    check("order fields: " + VENDOR_ORDER_FIELDS, Object.keys(first).sort().join() === VENDOR_ORDER_FIELDS, Object.keys(first));
    check("same field names as the customer's order, except vendor -> customer", VENDOR_ORDER_FIELDS.replace("customer", "vendor").split(",").sort().join() === CUSTOMER_ORDER_FIELDS);
    check("customer info is only _id and name", Object.keys(first.customer).sort().join() === "_id,name" && first.customer._id === String(cust1.id) && first.customer.name === "cust1", first.customer);
    check("item info: _id, itemName, category, price, location, images", Object.keys(first.item).sort().join() === "_id,category,images,itemName,location,price" && first.item.itemName === "Pizza of A", first.item);
    check("deliveryDate, deliveryAddress and message are there, same types as the customer API", first.deliveryDate.endsWith("T00:00:00.000Z") && first.deliveryAddress === "House 1, Road 2, Dhaka" && first.message === "first" && first.status === "pending");
    const text = JSON.stringify(res.body);
    check("no email, password, role, customerId or vendorId anywhere in the list", !/@pizzahub\.test|password|customerId|vendorId|"role"|isBlocked/i.test(text), text.match(/@pizzahub\.test|password|customerId|vendorId|"role"|isBlocked/i)?.[0]);

    // the customer API still returns what it returned before
    const mine = await call("GET", "/api/orders/my-orders", cust1.token);
    check("customer order API unchanged: same fields as before, still has vendor", mine.status === 200 && Object.keys(mine.body.data[0]).sort().join() === CUSTOMER_ORDER_FIELDS && mine.body.data.find((o: Json) => o._id === a1.id)?.vendor?.name === "vendora", Object.keys(mine.body.data[0]));
    const mineOne = await call("GET", `/api/orders/${a1.id}`, cust1.token);
    check("customer order details unchanged", mineOne.status === 200 && Object.keys(mineOne.body.data).sort().join() === CUSTOMER_ORDER_FIELDS);

    mix.push({ id: a1.id, status: "pending" }, { id: a2.id, status: "pending" }, { id: a3.id, status: "pending" });
  }

  // ------------------------------------------------------------ accept
  section("3. Accept");
  {
    const o = await placeOrder(cust1, itemA);
    const res = await call("PATCH", `${BASE}/${o.id}/accept`, vendorA.token);
    check("pending order -> 200 success, message set", res.status === 200 && res.body.success === true && typeof res.body.message === "string", res.body);
    check("data.status is accepted, same order, same fields as the list", res.body.data._id === o.id && res.body.data.status === "accepted" && Object.keys(res.body.data).sort().join() === VENDOR_ORDER_FIELDS, res.body.data);
    check("stored status is accepted, nothing else changed", (await dbStatus(o.id)) === "accepted" && (await ordersCollection().findOne({ _id: new ObjectId(o.id) }))?.deliveryAddress === "House 1, Road 2, Dhaka");
    check("the customer sees it as accepted", (await call("GET", `/api/orders/${o.id}`, cust1.token)).body.data.status === "accepted");

    const again = await call("PATCH", `${BASE}/${o.id}/accept`, vendorA.token);
    check("accepting again -> 409 INVALID_STATUS_TRANSITION 'already accepted'", again.status === 409 && again.body.code === "INVALID_STATUS_TRANSITION" && /already accepted/.test(again.body.message), again.body);
    const reject = await call("PATCH", `${BASE}/${o.id}/reject`, vendorA.token);
    check("rejecting an accepted order -> 409, stays accepted", reject.status === 409 && reject.body.code === "INVALID_STATUS_TRANSITION" && (await dbStatus(o.id)) === "accepted", reject.body);
    const cancel = await call("PATCH", `/api/orders/${o.id}/cancel`, cust1.token);
    check("the customer cannot cancel an accepted order (unchanged rule) -> 409", cancel.status === 409 && (await dbStatus(o.id)) === "accepted", cancel.body);
    const dupe = await call("POST", "/api/orders", cust1.token, { itemId: String(itemA), deliveryDate: o.deliveryDate, deliveryAddress: "x" });
    check("an ACCEPTED order still blocks a duplicate order -> 409 DUPLICATE_ORDER", dupe.status === 409 && dupe.body.code === "DUPLICATE_ORDER", dupe.body);
  }

  // ------------------------------------------------------------ reject
  section("4. Reject");
  {
    const o = await placeOrder(cust1, itemA);
    const res = await call("PATCH", `${BASE}/${o.id}/reject`, vendorA.token);
    check("pending order -> 200 success, message set", res.status === 200 && res.body.success === true && typeof res.body.message === "string", res.body);
    check("data.status is rejected, same fields as the list", res.body.data._id === o.id && res.body.data.status === "rejected" && Object.keys(res.body.data).sort().join() === VENDOR_ORDER_FIELDS, res.body.data);
    check("stored status is rejected", (await dbStatus(o.id)) === "rejected");

    const again = await call("PATCH", `${BASE}/${o.id}/reject`, vendorA.token);
    check("rejecting again -> 409 INVALID_STATUS_TRANSITION 'already rejected'", again.status === 409 && again.body.code === "INVALID_STATUS_TRANSITION" && /already rejected/.test(again.body.message), again.body);
    const accept = await call("PATCH", `${BASE}/${o.id}/accept`, vendorA.token);
    check("accepting a rejected order -> 409, stays rejected", accept.status === 409 && (await dbStatus(o.id)) === "rejected", accept.body);

    // the customer may order the same item and day again (the unique index only covers pending + accepted)
    const reorder = await call("POST", "/api/orders", cust1.token, { itemId: String(itemA), deliveryDate: o.deliveryDate, deliveryAddress: "House 1, Road 2, Dhaka" });
    check("after the rejection the same customer orders the same item on the same day again -> 201", reorder.status === 201 && reorder.body.data.status === "pending", reorder.body);
    const reorderDup = await call("POST", "/api/orders", cust1.token, { itemId: String(itemA), deliveryDate: o.deliveryDate, deliveryAddress: "x" });
    check("...and now that new pending order blocks another duplicate -> 409", reorderDup.status === 409 && reorderDup.body.code === "DUPLICATE_ORDER");
    const index = (await getDB().collection("orders").indexes()).find((i) => i.name === "orders_active_customer_item_date_uidx");
    check("the partial unique index orders_active_customer_item_date_uidx is still there, unchanged", Boolean(index?.unique) && JSON.stringify(index?.partialFilterExpression) === '{"status":{"$in":["pending","accepted"]}}', index);
    check("the rejected order and the new one both exist for that day", (await ordersCollection().countDocuments({ itemId: itemA, customerId: cust1.id, deliveryDate: new Date(`${o.deliveryDate}T00:00:00Z`) })) === 2);
  }

  // ------------------------------------------------------------ cancelled
  section("5. A cancelled order cannot be accepted or rejected");
  {
    const o = await placeOrder(cust1, itemA);
    check("setup: the customer cancels it", (await call("PATCH", `/api/orders/${o.id}/cancel`, cust1.token)).status === 200);
    const accept = await call("PATCH", `${BASE}/${o.id}/accept`, vendorA.token);
    check("accept a cancelled order -> 409 INVALID_STATUS_TRANSITION", accept.status === 409 && accept.body.code === "INVALID_STATUS_TRANSITION" && /cancelled/.test(accept.body.message), accept.body);
    const reject = await call("PATCH", `${BASE}/${o.id}/reject`, vendorA.token);
    check("reject a cancelled order -> 409 INVALID_STATUS_TRANSITION", reject.status === 409 && reject.body.code === "INVALID_STATUS_TRANSITION", reject.body);
    check("it stays cancelled", (await dbStatus(o.id)) === "cancelled");
  }

  // ------------------------------------------------------------ ownership
  section("6. Another vendor's order");
  {
    const o = await placeOrder(cust1, itemA);
    for (const action of ["accept", "reject"] as const) {
      const r = await call("PATCH", `${BASE}/${o.id}/${action}`, vendorB.token);
      check(`vendor B ${action}s vendor A's order -> 404 ORDER_NOT_FOUND`, r.status === 404 && r.body.code === "ORDER_NOT_FOUND", r.body);
    }
    const unknown = await call("PATCH", `${BASE}/${new ObjectId()}/accept`, vendorB.token);
    check("...the same answer as for an order that does not exist (nothing revealed)", unknown.status === 404 && unknown.body.message === "Order not found");
    check("vendor A's order is untouched", (await dbStatus(o.id)) === "pending");
    const own = await call("PATCH", `${BASE}/${o.id}/accept`, vendorA.token);
    check("the real owner can still accept it -> 200", own.status === 200);
  }

  // ------------------------------------------------------------ input
  section("7. Invalid ids, missing orders, body fields");
  {
    const o = await placeOrder(cust1, itemA);

    for (const action of ["accept", "reject"] as const) {
      for (const bad of ["not-an-id", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", "507f1f77bcf86cd79943901"]) {
        const r = await call("PATCH", `${BASE}/${bad}/${action}`, vendorA.token);
        check(`${action}: id "${bad}" -> 400 VALIDATION_ERROR`, r.status === 400 && r.body.code === "VALIDATION_ERROR" && r.body.errors?.[0]?.field === "id", r.body);
      }
      const missing = await call("PATCH", `${BASE}/${new ObjectId()}/${action}`, vendorA.token);
      check(`${action}: well-formed but unknown id -> 404 ORDER_NOT_FOUND`, missing.status === 404 && missing.body.code === "ORDER_NOT_FOUND" && missing.body.success === false, missing.body);
    }

    for (const field of [{ status: "accepted" }, { vendorId: String(vendorB.id) }, { customerId: String(cust2.id) }, { itemId: String(itemB) }, { isAdmin: true }]) {
      const key = Object.keys(field)[0]!;
      const r = await call("PATCH", `${BASE}/${o.id}/accept`, vendorA.token, field);
      check(`body field "${key}" is refused -> 400, order untouched`, r.status === 400 && r.body.code === "VALIDATION_ERROR" && r.body.errors?.some((e: Json) => e.field === key) && (await dbStatus(o.id)) === "pending", r.body);
    }
    const stored = await ordersCollection().findOne({ _id: new ObjectId(o.id) });
    check("the stored vendorId / customerId / itemId did not change", stored!.vendorId.equals(vendorA.id) && stored!.customerId.equals(cust1.id) && stored!.itemId.equals(itemA));
    check("an empty JSON body {} is fine -> 200", (await call("PATCH", `${BASE}/${o.id}/accept`, vendorA.token, {})).status === 200);
  }

  // ------------------------------------------------------------ list: filter, pagination
  section("8. Status filter and pagination");
  {
    await ordersCollection().deleteMany({});
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push((await placeOrder(i % 2 ? cust1 : cust2, i % 3 ? itemA : itemA2)).id);
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    await call("PATCH", `${BASE}/${ids[0]}/accept`, vendorA.token);
    await call("PATCH", `${BASE}/${ids[1]}/accept`, vendorA.token);
    await call("PATCH", `${BASE}/${ids[2]}/reject`, vendorA.token);
    await call("PATCH", `/api/orders/${ids[3]}/cancel`, cust1.token); // ids[3] was ordered by cust1 (odd index)
    // ids 4, 5, 6 stay pending; vendor B has one order of their own
    await placeOrder(cust1, itemB);

    const names = async (qs: string) => (await call("GET", `${BASE}?${qs}`, vendorA.token)).body;
    for (const [status, count] of [["pending", 3], ["accepted", 2], ["rejected", 1], ["cancelled", 1]] as const) {
      const r = await names(`status=${status}`);
      check(`?status=${status} -> ${count} order(s), all ${status}, totalItems matches`, r.data.length === count && r.data.every((o: Json) => o.status === status) && r.pagination.totalItems === count, r.pagination);
    }
    check("no filter -> all 7 of vendor A's orders (B's is not counted)", (await names("")).pagination.totalItems === 7);
    check("?status=pending newest first", JSON.stringify((await names("status=pending")).data.map((o: Json) => o._id)) === JSON.stringify([ids[6], ids[5], ids[4]]));
    check("vendor B's status filter only sees B's order", (await call("GET", `${BASE}?status=pending`, vendorB.token)).body.pagination.totalItems === 1);

    const p1 = await names("limit=3&page=1");
    const p2 = await names("limit=3&page=2");
    const p3 = await names("limit=3&page=3");
    const p4 = await names("limit=3&page=4");
    check("limit=3: pages hold 3 / 3 / 1 / 0 orders, totalItems 7, totalPages 3", [p1, p2, p3, p4].map((p) => p.data.length).join() === "3,3,1,0" && p1.pagination.totalItems === 7 && p1.pagination.totalPages === 3, p1.pagination);
    check("hasNextPage / hasPreviousPage correct", p1.pagination.hasNextPage === true && p1.pagination.hasPreviousPage === false && p3.pagination.hasNextPage === false && p3.pagination.hasPreviousPage === true);
    check("pages together = all 7 orders once, newest first", [...p1.data, ...p2.data, ...p3.data].map((o: Json) => o._id).join() === [...ids].reverse().join());
    const filteredPage = await names("status=pending&limit=2&page=2");
    check("pagination follows the filter (3 pending, limit 2, page 2 -> 1 item, 2 pages)", filteredPage.data.length === 1 && filteredPage.pagination.totalItems === 3 && filteredPage.pagination.totalPages === 2, filteredPage.pagination);
    check("default limit is 12", p1.pagination.limit === 3 && (await names("")).pagination.limit === 12);

    for (const [qs, label] of [["status=bogus", "invalid status"], ["status=", "empty status"], ["status=pending&status=accepted", "repeated status"], ["page=0", "page 0"], ["page=abc", "page abc"], ["limit=51", "limit above max"], ["limit=-1", "negative limit"]] as const) {
      const r = await call("GET", `${BASE}?${qs}`, vendorA.token);
      check(`${label} -> 400 VALIDATION_ERROR`, r.status === 400 && r.body.code === "VALIDATION_ERROR", r.body);
    }

    const fresh = await makeUser("freshvendor", "vendor");
    const empty = await call("GET", BASE, fresh.token);
    check("a vendor with no orders -> 200, data [], totalItems 0, totalPages 0", empty.status === 200 && empty.body.data.length === 0 && empty.body.pagination.totalItems === 0 && empty.body.pagination.totalPages === 0, empty.body);

    // an order whose item or customer is gone is still listed
    const gone = await seedItem(vendorA.id, "Will be deleted");
    const goneOrder = await placeOrder(cust2, gone);
    await menuItemsCollection().deleteOne({ _id: gone });
    const afterDelete = (await names("limit=1")).data[0];
    check("an order whose item was deleted is still listed (item: null)", afterDelete._id === goneOrder.id && afterDelete.item === null && afterDelete.customer?.name === "cust2", afterDelete);
  }

  // ------------------------------------------------------------ concurrency
  section("9. Accept, reject and cancel at the same moment");
  {
    await ordersCollection().deleteMany({});

    const wins = (results: Res[]) => results.filter((r) => r.status === 200).length;
    const losses = (results: Res[]) => results.filter((r) => r.status === 409 && r.body.code === "INVALID_STATUS_TRANSITION").length;

    // 1) accept x4 -> one winner
    const a = await placeOrder(cust1, itemA);
    const accepts = await Promise.all(Array.from({ length: 4 }, () => call("PATCH", `${BASE}/${a.id}/accept`, vendorA.token)));
    check("4 accepts at once -> exactly one 200, three 409", wins(accepts) === 1 && losses(accepts) === 3, accepts.map((r) => r.status));
    check("...stored status is accepted", (await dbStatus(a.id)) === "accepted");

    // 2) accept vs reject vs cancel, many rounds: never more than one succeeds, stored status = the winner
    let allOk = true;
    let seen = new Set<string>();
    const detail: unknown[] = [];

    for (let round = 0; round < 12; round++) {
      const o = await placeOrder(cust1, itemA);
      const results = await Promise.all([
        call("PATCH", `${BASE}/${o.id}/accept`, vendorA.token),
        call("PATCH", `${BASE}/${o.id}/reject`, vendorA.token),
        call("PATCH", `/api/orders/${o.id}/cancel`, cust1.token),
        call("PATCH", `${BASE}/${o.id}/accept`, vendorA.token),
        call("PATCH", `/api/orders/${o.id}/cancel`, cust1.token),
      ]);
      const winners = results.map((r, i) => [r, i] as const).filter(([r]) => r.status === 200);
      const finalStatus = await dbStatus(o.id);
      const expected = winners.length === 1 ? ({ 0: "accepted", 1: "rejected", 2: "cancelled", 3: "accepted", 4: "cancelled" } as Record<number, string>)[winners[0]![1]] : undefined;
      const rest = results.filter((r) => r.status !== 200).every((r) => r.status === 409 && r.body.code === "INVALID_STATUS_TRANSITION");
      if (winners.length !== 1 || finalStatus !== expected || !rest) {
        allOk = false;
        detail.push({ round, statuses: results.map((r) => r.status), finalStatus });
      }
      seen.add(finalStatus ?? "?");
    }
    check("12 rounds of accept + reject + cancel (x2) at once: exactly one wins every time, the stored status is the winner's, all others 409", allOk, detail);
    console.log(`       (outcomes seen across the rounds: ${[...seen].sort().join(", ")})`);

    // 3) the active-order index stays consistent: whatever won, at most ONE active order for that day
    const day = nextDay();
    const o = await placeOrder(cust1, itemA, day);
    await Promise.all([call("PATCH", `${BASE}/${o.id}/reject`, vendorA.token), call("PATCH", `/api/orders/${o.id}/cancel`, cust1.token)]);
    const again = await call("POST", "/api/orders", cust1.token, { itemId: String(itemA), deliveryDate: day, deliveryAddress: "x" });
    check("after a reject-vs-cancel race the day is free again -> a new order is 201", again.status === 201, again.body);
    const active = await ordersCollection().countDocuments({ itemId: itemA, customerId: cust1.id, deliveryDate: new Date(`${day}T00:00:00Z`), status: { $in: ["pending", "accepted"] } });
    check("...and exactly one ACTIVE order exists for that item and day", active === 1, active);
  }

  // ------------------------------------------------------------ regression
  section("10. Nothing else changed");
  {
    check("public menu / categories / health still 200", (await call("GET", "/api/menu-items", null)).status === 200 && (await call("GET", "/api/categories", null)).status === 200 && (await call("GET", "/api/health", null)).status === 200);
    check("vendor menu list still 200 for a vendor, 403 for a customer", (await call("GET", "/api/vendor/menu-items", vendorA.token)).status === 200 && (await call("GET", "/api/vendor/menu-items", cust1.token)).status === 403);
    check("admin menu list still 200 for an admin", (await call("GET", "/api/admin/menu-items", admin.token)).status === 200);
    check("a vendor still cannot use the customer order API (403)", (await call("POST", "/api/orders", vendorA.token, {})).status === 403);

    // an accepted order still blocks the vendor from deleting the item (existing rule)
    const target = await seedItem(vendorA.id, "Has an accepted order");
    const o = await placeOrder(cust1, target);
    await call("PATCH", `${BASE}/${o.id}/accept`, vendorA.token);
    const blocked = await call("DELETE", `/api/vendor/menu-items/${target}`, vendorA.token);
    check("an accepted order still blocks deleting the item (409 ITEM_HAS_OPEN_ORDERS)", blocked.status === 409 && blocked.body.code === "ITEM_HAS_OPEN_ORDERS", blocked.body);
    const rejectedOne = await placeOrder(cust2, target);
    await call("PATCH", `${BASE}/${rejectedOne.id}/reject`, vendorA.token);
    await ordersCollection().updateOne({ _id: new ObjectId(o.id) }, { $set: { status: "rejected" } }); // the vendor-side "done" state for this check
    check("once no order is open any more, the vendor can delete the item -> 200", (await call("DELETE", `/api/vendor/menu-items/${target}`, vendorA.token)).status === 200);
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
