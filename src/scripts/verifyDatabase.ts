/**
 * Database verification:  npm run verify:db
 *
 * Runs against a THROWAWAY database (pizzahub_verify_<timestamp>) on the same
 * cluster and drops it at the end, so your real data is never touched.
 * Exit code 0 = every check passed.
 */
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { ObjectId } from "mongodb";

const TEST_DB = `pizzahub_verify_${Date.now()}`;
const TEST_DB_PREFIX = "pizzahub_verify_";

// Must be set before config/env.ts is loaded, hence the dynamic imports below.
process.env.DB_NAME = TEST_DB;

const { connectDB, client } = await import("../config/db.js");
const { initializeDatabase } = await import("../config/initDatabase.js");
const { auth } = await import("../lib/auth.js");
const models = await import("../models/index.js");

let passed = 0;
let failed = 0;

const check = (name: string, ok: boolean, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `   <-- ${detail}`}`);
};

/** Runs `fn`, returns the error it threw (or null). */
const errorOf = async (fn: () => Promise<unknown>): Promise<{ code?: number; message?: string } | null> => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error as { code?: number; message?: string };
  }
};

const DUPLICATE_KEY = 11000;
const DOCUMENT_VALIDATION_FAILURE = 121;

const BUSINESS = ["users", "menuItems", "orders", "transactions"];
const BETTER_AUTH_MANAGED = ["session", "account", "verification", "jwks"];

const oid = () => new ObjectId();
const validMenuItem = () => ({
  vendorId: oid().toHexString(),
  itemName: "Margherita",
  category: "pizza",
  description: "Tomato, mozzarella, basil",
  price: 12.5,
  location: "Dhaka",
  images: ["https://example.com/a.jpg"],
});
const validOrder = () => ({
  itemId: oid().toHexString(),
  vendorId: oid().toHexString(),
  customerId: oid().toHexString(),
  deliveryDate: "2030-01-15",
  deliveryAddress: "House 1, Road 2, Dhaka",
});
const validTransaction = (session = `cs_test_${oid().toHexString()}`) => ({
  vendorId: oid().toHexString(),
  plan: "premium" as const,
  amount: 999,
  currency: "USD",
  stripeSessionId: session,
});

try {
  const db = await connectDB();

  // ───────── 1. connection ─────────
  const ping = await db.command({ ping: 1 });
  check("1  MongoDB connection + ping", ping.ok === 1);

  const bad = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      MONGODB_URI: "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=1500",
      PORT: "5098",
    },
  });
  check(
    "1b server with an unreachable database exits with an error and never prints 'running'",
    bad.status === 1 && !/is running on port/.test(bad.stdout ?? ""),
    `status=${bad.status} stdout=${bad.stdout} stderr=${(bad.stderr ?? "").slice(0, 200)}`
  );

  // ───────── 2. structure ─────────
  const first = await initializeDatabase(db);
  check(
    "2a first init creates menuItems, orders, transactions (users has only its index)",
    isDeepStrictEqual([...first.collectionsCreated].sort(), ["menuItems", "orders", "transactions"]) &&
      first.problems.length === 0,
    JSON.stringify(first)
  );

  const requiredFields: Record<string, string[]> = {
    menuItems: ["vendorId", "itemName", "category", "description", "price", "location", "images", "status", "createdAt"],
    orders: ["itemId", "vendorId", "customerId", "deliveryDate", "deliveryAddress", "status", "createdAt"],
    transactions: ["vendorId", "plan", "amount", "currency", "stripeSessionId", "stripeSubscriptionId", "status", "createdAt"],
  };
  for (const [name, required] of Object.entries(requiredFields)) {
    const [info] = await db.listCollections({ name }, { nameOnly: false }).toArray();
    const schema = (info?.options?.validator as any)?.$jsonSchema;
    check(
      `2b ${name}: validator has the required fields, strict + error`,
      isDeepStrictEqual([...(schema?.required ?? [])].sort(), [...required].sort()) &&
        info?.options?.validationLevel === "strict" &&
        info?.options?.validationAction === "error",
      JSON.stringify(info?.options)
    );
  }

  // ───────── 3. Better Auth still works ─────────
  const customerEmail = `customer_${Date.now()}@verify.test`;
  const vendorEmail = `vendor_${Date.now()}@verify.test`;
  const password = "Passw0rdOK";

  await auth.api.signUpEmail({ body: { name: "Cust", email: customerEmail, password } });
  await auth.api.signUpEmail({
    body: { name: "Vend", email: vendorEmail, password, role: "vendor", businessName: "Pizza Palace" },
  });

  const customer = await db.collection("users").findOne({ email: customerEmail });
  const vendor = await db.collection("users").findOne({ email: vendorEmail });

  check("3a user _id is an ObjectId (so vendorId/customerId references line up)", customer?._id instanceof ObjectId);
  check(
    "3b new user: role=customer, isBlocked=false, plan=free, subscriptionExpiresAt=null, createdAt/updatedAt are Dates",
    customer?.role === "customer" &&
      customer?.isBlocked === false &&
      customer?.subscriptionPlan === "free" &&
      customer?.subscriptionExpiresAt === null &&
      customer?.createdAt instanceof Date &&
      customer?.updatedAt instanceof Date,
    JSON.stringify(customer)
  );
  check(
    "3c new vendor: role=vendor, plan=free, businessName kept",
    vendor?.role === "vendor" && vendor?.subscriptionPlan === "free" && vendor?.businessName === "Pizza Palace",
    JSON.stringify(vendor)
  );

  const signedIn = await auth.api.signInEmail({ body: { email: customerEmail, password } });
  check("3d email/password sign-in still works", Boolean(signedIn.token) && signedIn.user.email === customerEmail);

  const adminAttempt = await errorOf(() =>
    auth.api.signUpEmail({ body: { name: "Evil", email: `evil_${Date.now()}@verify.test`, password, role: "admin" } })
  );
  check("3e sign-up with role=admin is still rejected", adminAttempt !== null, "no error thrown");

  const dupSignUp = await errorOf(() => auth.api.signUpEmail({ body: { name: "Dup", email: customerEmail, password } }));
  check("3f Better Auth rejects a second sign-up with the same email", dupSignUp !== null, "no error thrown");

  const collectionNames = (await db.listCollections().toArray()).map((c) => c.name);
  const unexpected = collectionNames.filter((n) => !BUSINESS.includes(n) && !BETTER_AUTH_MANAGED.includes(n));
  check(
    "2c only the 4 business collections + Better Auth's own exist (no carts, payments, ...)",
    BUSINESS.every((n) => collectionNames.includes(n)) && unexpected.length === 0,
    `unexpected: ${unexpected.join(", ")}`
  );

  // ───────── 4. indexes ─────────
  const expectedIndexes: Array<[string, Record<string, 1 | -1>, boolean]> = [
    ["users", { email: 1 }, true],
    ["menuItems", { vendorId: 1 }, false],
    ["menuItems", { status: 1, createdAt: -1 }, false],
    ["menuItems", { category: 1, status: 1 }, false],
    ["menuItems", { price: 1 }, false],
    ["orders", { customerId: 1, createdAt: -1 }, false],
    ["orders", { vendorId: 1, status: 1 }, false],
    ["orders", { itemId: 1, customerId: 1, deliveryDate: 1, status: 1 }, false],
    ["transactions", { stripeSessionId: 1 }, true],
    ["transactions", { vendorId: 1, createdAt: -1 }, false],
  ];
  const countIndexes = async () =>
    Object.fromEntries(await Promise.all(BUSINESS.map(async (n) => [n, (await db.collection(n).indexes()).length] as const)));

  for (const [collection, key, unique] of expectedIndexes) {
    const found = (await db.collection(collection).indexes()).find((i) => isDeepStrictEqual(i.key, key));
    check(
      `4  index ${collection} ${JSON.stringify(key)}${unique ? " UNIQUE" : ""}`,
      Boolean(found) && Boolean(found?.unique) === unique,
      JSON.stringify(found)
    );
  }
  const usersIndexes = (await db.collection("users").indexes()).filter((i) => i.name !== "_id_");
  check("4b users has exactly one email index (no duplicate next to Better Auth's)", usersIndexes.length === 1, JSON.stringify(usersIndexes));

  // ───────── 5. unique email ─────────
  const dupEmail = await errorOf(() =>
    db.collection("users").insertOne({ name: "Raw dup", email: customerEmail, role: "customer", isBlocked: false })
  );
  check("5  unique email index rejects a duplicate (E11000)", dupEmail?.code === DUPLICATE_KEY, JSON.stringify(dupEmail));

  // ───────── valid documents are accepted ─────────
  const menuItem = models.buildMenuItem(validMenuItem());
  const order = models.buildOrder({ ...validOrder(), message: "Extra cheese" });
  check("   valid menu item: defaults status=pending, vendorId is ObjectId, createdAt is Date",
    menuItem.status === "pending" && menuItem.vendorId instanceof ObjectId && menuItem.createdAt instanceof Date);
  check("   valid order: defaults status=pending, ids are ObjectIds, deliveryDate is Date, message optional",
    order.status === "pending" && order.itemId instanceof ObjectId && order.deliveryDate instanceof Date && order.message === "Extra cheese");
  check("   MongoDB accepts the valid menu item and order",
    (await errorOf(() => models.menuItemsCollection().insertOne(menuItem))) === null &&
      (await errorOf(() => models.ordersCollection().insertOne(order))) === null);

  const tx = models.transactionSchema.parse(validTransaction());
  check("   valid transaction: plan=premium, currency lower-cased, stripeSubscriptionId=null, status=pending",
    tx.plan === "premium" && tx.currency === "usd" && tx.stripeSubscriptionId === null && tx.status === "pending");
  check("   MongoDB accepts the valid transaction", (await errorOf(() => models.transactionsCollection().insertOne(tx))) === null);

  // ───────── 6. unique stripeSessionId ─────────
  const sameSession = models.transactionSchema.parse(validTransaction(tx.stripeSessionId));
  const dupSession = await errorOf(() => models.transactionsCollection().insertOne(sameSession));
  check("6  unique stripeSessionId rejects a duplicate (E11000)", dupSession?.code === DUPLICATE_KEY, JSON.stringify(dupSession));

  // ───────── 7. invalid enum values ─────────
  check("7a zod rejects invalid enum values (menu status, order status, transaction status, plan)",
    !models.menuItemSchema.safeParse({ ...validMenuItem(), status: "bogus" }).success &&
      !models.orderSchema.safeParse({ ...validOrder(), status: "bogus" }).success &&
      !models.transactionSchema.safeParse({ ...validTransaction(), status: "bogus" }).success &&
      !models.transactionSchema.safeParse({ ...validTransaction(), plan: "basic" }).success);

  const raw = (collection: string, doc: object) => errorOf(() => db.collection(collection).insertOne({ ...doc }));
  const goodMenu = () => ({ ...models.buildMenuItem(validMenuItem()) });
  const goodOrder = () => ({ ...models.buildOrder(validOrder()) });
  const goodTx = () => ({ ...models.transactionSchema.parse(validTransaction()) });

  const rawEnum = await Promise.all([
    raw("menuItems", { ...goodMenu(), status: "bogus" }),
    raw("orders", { ...goodOrder(), status: "bogus" }),
    raw("transactions", { ...goodTx(), status: "bogus" }),
    raw("transactions", { ...goodTx(), plan: "basic" }),
  ]);
  check("7b MongoDB itself rejects invalid enum values even when zod is bypassed (code 121)",
    rawEnum.every((e) => e?.code === DOCUMENT_VALIDATION_FAILURE), JSON.stringify(rawEnum.map((e) => e?.code)));

  // ───────── 8. invalid price / amount ─────────
  check("8a zod rejects price 0, -5, '10' (string); amount 0, -1",
    [0, -5, "10"].every((price) => !models.menuItemSchema.safeParse({ ...validMenuItem(), price }).success) &&
      [0, -1].every((amount) => !models.transactionSchema.safeParse({ ...validTransaction(), amount }).success));

  const rawPrice = await Promise.all([
    raw("menuItems", { ...goodMenu(), price: 0 }),
    raw("menuItems", { ...goodMenu(), price: -5 }),
    raw("menuItems", { ...goodMenu(), price: "10" }),
    raw("transactions", { ...goodTx(), amount: 0 }),
    raw("transactions", { ...goodTx(), amount: -1 }),
  ]);
  check("8b MongoDB itself rejects price/amount <= 0 and non-numbers (code 121)",
    rawPrice.every((e) => e?.code === DOCUMENT_VALIDATION_FAILURE), JSON.stringify(rawPrice.map((e) => e?.code)));

  // ───────── other integrity rules ─────────
  check("   zod rejects an invalid ObjectId, bad dates, non-string images, missing fields, and client-set status",
    !models.menuItemSchema.safeParse({ ...validMenuItem(), vendorId: "123" }).success &&
      !models.orderSchema.safeParse({ ...validOrder(), deliveryDate: "not-a-date" }).success &&
      !models.orderSchema.safeParse({ ...validOrder(), deliveryDate: null }).success &&
      !models.orderSchema.safeParse({ ...validOrder(), deliveryDate: 12345 }).success &&
      !models.menuItemSchema.safeParse({ ...validMenuItem(), images: [1, 2] }).success &&
      !models.menuItemSchema.safeParse({ ...validMenuItem(), itemName: "" }).success &&
      !models.orderSchema.safeParse({ ...validOrder(), customerId: undefined }).success &&
      !models.createMenuItemSchema.safeParse({ ...validMenuItem(), status: "approved" }).success);
  const rawShape = await Promise.all([
    raw("menuItems", { ...goodMenu(), vendorId: oid().toHexString() }), // string instead of ObjectId
    raw("menuItems", { ...goodMenu(), images: [1, 2] }),
    raw("orders", { ...goodOrder(), deliveryDate: "2030-01-01" }), // string instead of Date
  ]);
  check("   MongoDB rejects string ids, non-string images and string dates (code 121)",
    rawShape.every((e) => e?.code === DOCUMENT_VALIDATION_FAILURE), JSON.stringify(rawShape.map((e) => e?.code)));

  // ───────── 9. restart does not duplicate anything ─────────
  const before = await countIndexes();
  const second = await initializeDatabase(db);
  const third = await initializeDatabase(db);
  const after = await countIndexes();
  check("9  re-running init (a restart) creates nothing and changes nothing",
    [second, third].every((r) => !r.collectionsCreated.length && !r.validatorsUpdated.length && !r.indexesCreated.length && !r.problems.length) &&
      isDeepStrictEqual(before, after),
    JSON.stringify({ second, before, after }));

  // ───────── duplicates are reported, never deleted ─────────
  const transactions = db.collection("transactions");
  await transactions.dropIndex("transactions_stripeSessionId_uidx");
  const dupDocs = [goodTx(), goodTx()].map((t) => ({ ...t, stripeSessionId: "dup-session" }));
  await transactions.insertMany(dupDocs);
  const withDuplicates = await initializeDatabase(db);
  const stillThere = await transactions.countDocuments({ stripeSessionId: "dup-session" });
  check("   existing duplicates: unique index is NOT created, problem is reported, nothing is deleted",
    withDuplicates.problems.some((p) => p.includes("transactions_stripeSessionId_uidx")) &&
      withDuplicates.indexesCreated.every((i) => !i.includes("stripeSessionId")) &&
      stillThere === 2,
    JSON.stringify({ withDuplicates, stillThere }));
  await transactions.deleteMany({ stripeSessionId: "dup-session" }); // our own test rows
  const repaired = await initializeDatabase(db);
  check("   after the duplicates are fixed, the next start creates the unique index",
    repaired.indexesCreated.includes("transactions.transactions_stripeSessionId_uidx") && repaired.problems.length === 0,
    JSON.stringify(repaired));
} catch (error) {
  failed++;
  console.log("SCRIPT ERROR", error);
} finally {
  try {
    const db = client.db(TEST_DB);
    if (db.databaseName === TEST_DB && TEST_DB.startsWith(TEST_DB_PREFIX)) {
      await db.dropDatabase();
      console.log(`\nDropped temporary database ${TEST_DB}`);
    }
  } catch (error) {
    console.log(`WARN  could not drop ${TEST_DB} (${(error as Error).message}). Drop it manually in Atlas.`);
  }

  await client.close();
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
