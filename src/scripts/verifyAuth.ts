/**
 * Checks the Better Auth hooks over real HTTP: `npm run verify:auth`.
 *
 * Focus: nobody can change their own role (or any other protected field) through
 * POST /api/auth/update-user, while the allowed fields (name, image, businessName) still work,
 * and sign-up keeps accepting only the roles "customer" and "vendor".
 *
 * Real sign-up, real Better Auth sessions, real MongoDB. DB_NAME is switched to a throwaway
 * database (pizzahub_auth_verify_<timestamp>) BEFORE the app is loaded and dropped at the end.
 */
process.env.DB_NAME = `pizzahub_auth_verify_${Date.now()}`;

const { default: app } = await import("../app.js");
const { env } = await import("../config/env.js");
const { client, connectDB, getDB } = await import("../config/db.js");
const { initializeDatabase } = await import("../config/initDatabase.js");
const { usersCollection } = await import("../models/index.js");

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

const PASSWORD = "Passw0rdOK";
const runId = Date.now();
let baseUrl = "";

const post = async (path: string, body: unknown, cookie?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json", origin: env.CLIENT_URL };
  if (cookie) headers.cookie = cookie;

  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  let json: Json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }

  return { status: response.status, body: json, headers: response.headers };
};

const signUp = async (label: string, extra: Record<string, unknown>) => {
  const email = `${label}.${runId}@pizzahub.test`.toLowerCase();
  const res = await post("/api/auth/sign-up/email", { name: label, email, password: PASSWORD, ...extra });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  return { res, email, cookie };
};

const dbUser = (email: string) => usersCollection().findOne({ email });

const server = app.listen(0);

try {
  await connectDB();
  await initializeDatabase();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  section("Setting up real users");
  const customer = await signUp("customer", { role: "customer" });
  const vendor = await signUp("vendor", { role: "vendor" });
  check("customer and vendor signed up (200) and have a session cookie", customer.res.status === 200 && vendor.res.status === 200 && customer.cookie.length > 0 && vendor.cookie.length > 0, [customer.res.status, vendor.res.status]);

  const UPDATE = "/api/auth/update-user";

  // ------------------------------------------------------------ role
  section("1. update-user: the role can never be changed");
  {
    const toVendor = await post(UPDATE, { role: "vendor" }, customer.cookie);
    check('customer {role:"vendor"} -> 400 "Role cannot be changed."', toVendor.status === 400 && toVendor.body?.message === "Role cannot be changed.", toVendor);
    check("...and the role in the database is still customer", (await dbUser(customer.email))?.role === "customer");

    const same = await post(UPDATE, { role: "customer" }, customer.cookie);
    check('customer {role:"customer"} (same value) -> 400 too, the key alone is refused', same.status === 400 && same.body?.message === "Role cannot be changed.", same);

    const admin = await post(UPDATE, { role: "admin" }, customer.cookie);
    check('customer {role:"admin"} -> 400, role still customer', admin.status === 400 && (await dbUser(customer.email))?.role === "customer", admin);

    const nulled = await post(UPDATE, { role: null }, customer.cookie);
    check("customer {role:null} -> 400", nulled.status === 400 && nulled.body?.message === "Role cannot be changed.", nulled);

    const empty = await post(UPDATE, { role: "" }, customer.cookie);
    check('customer {role:""} -> 400', empty.status === 400 && empty.body?.message === "Role cannot be changed.", empty);

    const toCustomer = await post(UPDATE, { role: "customer" }, vendor.cookie);
    check('vendor {role:"customer"} -> 400, role still vendor', toCustomer.status === 400 && (await dbUser(vendor.email))?.role === "vendor", toCustomer);

    const mixed = await post(UPDATE, { name: "Sneaky", role: "vendor" }, customer.cookie);
    const afterMixed = await dbUser(customer.email);
    check("{name, role} together -> 400 and NOTHING is applied (name unchanged too)", mixed.status === 400 && afterMixed?.name === "customer" && afterMixed?.role === "customer", [mixed.status, afterMixed?.name]);
  }

  // ------------------------------------------------------------ other protected fields
  section("2. update-user: only name, image and businessName are accepted");
  {
    const before = await dbUser(customer.email);

    const forbidden: [string, unknown][] = [
      ["email", `hijack.${runId}@pizzahub.test`],
      ["emailVerified", true],
      ["isBlocked", false],
      ["subscriptionPlan", "premium"],
      ["subscriptionExpiresAt", new Date(Date.now() + 86_400_000).toISOString()],
      ["subscriptionStatus", "active"],
      ["subscriptionCancelAtPeriodEnd", false],
      ["stripeCustomerId", "cus_fake"],
      ["stripeSubscriptionId", "sub_fake"],
      ["id", "000000000000000000000000"],
      ["_id", "000000000000000000000000"],
      ["createdAt", new Date(0).toISOString()],
      ["unknownField", "x"],
    ];

    for (const [key, value] of forbidden) {
      const res = await post(UPDATE, { [key]: value }, customer.cookie);
      check(`{${key}} -> 400`, res.status === 400 && res.body?.message === "Only name, image and businessName can be updated.", res);
    }

    const after = await dbUser(customer.email);
    check(
      "the user document is unchanged after all of those attempts (email, role, plan, expiry, blocked flag, Stripe ids)",
      after?.email === before?.email &&
        after?.role === before?.role &&
        (after?.subscriptionPlan ?? "free") === "free" &&
        (after?.subscriptionExpiresAt ?? null) === null &&
        after?.isBlocked !== true &&
        !("stripeCustomerId" in (after ?? {})) &&
        !("stripeSubscriptionId" in (after ?? {})),
      after
    );
    check("nobody can sign in with the hijack email", (await usersCollection().countDocuments({ email: `hijack.${runId}@pizzahub.test` })) === 0);
  }

  // ------------------------------------------------------------ allowed fields still work
  section("3. update-user: the allowed fields still work");
  {
    const name = await post(UPDATE, { name: "X" }, customer.cookie);
    const afterName = await dbUser(customer.email);
    check('customer {name:"X"} -> 200, name saved, role unchanged', name.status === 200 && afterName?.name === "X" && afterName?.role === "customer", [name.status, name.body, afterName?.name, afterName?.role]);

    const image = await post(UPDATE, { image: "https://example.com/me.png" }, customer.cookie);
    check("{image} -> 200, saved", image.status === 200 && (await dbUser(customer.email))?.image === "https://example.com/me.png", image);

    const business = await post(UPDATE, { businessName: "Kitchen One" }, vendor.cookie);
    check("vendor {businessName} -> 200, saved", business.status === 200 && (await dbUser(vendor.email))?.businessName === "Kitchen One", business);

    const several = await post(UPDATE, { name: "Vendor Two", image: "https://example.com/v.png", businessName: "Kitchen Two" }, vendor.cookie);
    const afterSeveral = await dbUser(vendor.email);
    check("{name, image, businessName} together -> 200, all saved, role still vendor", several.status === 200 && afterSeveral?.name === "Vendor Two" && afterSeveral?.businessName === "Kitchen Two" && afterSeveral?.role === "vendor", [several.status, afterSeveral]);

    const anonymous = await post(UPDATE, { name: "Nobody" });
    check("without a session -> 401, nothing changes", anonymous.status === 401, anonymous);
  }

  // ------------------------------------------------------------ sign-up unchanged
  section("4. sign-up: roles unchanged (customer / vendor only)");
  {
    const asVendor = await signUp("signupvendor", { role: "vendor" });
    check('sign-up with role "vendor" -> 200, stored as vendor', asVendor.res.status === 200 && (await dbUser(asVendor.email))?.role === "vendor", asVendor.res.status);

    const asCustomer = await signUp("signupcustomer", { role: "customer" });
    check('sign-up with role "customer" -> 200, stored as customer', asCustomer.res.status === 200 && (await dbUser(asCustomer.email))?.role === "customer", asCustomer.res.status);

    const noRole = await signUp("signupnorole", {});
    check("sign-up without a role -> 200, defaults to customer", noRole.res.status === 200 && (await dbUser(noRole.email))?.role === "customer", noRole.res.status);

    const asAdmin = await signUp("signupadmin", { role: "admin" });
    check('sign-up with role "admin" -> 400 and no user is created', asAdmin.res.status === 400 && (await dbUser(asAdmin.email)) === null, asAdmin.res.status);

    const junk = await signUp("signupjunk", { role: "superuser" });
    check('sign-up with an unknown role -> 400 and no user is created', junk.res.status === 400 && (await dbUser(junk.email)) === null, junk.res.status);

    const blocked = await signUp("signupblocked", { role: "customer", isBlocked: true, subscriptionPlan: "premium" });
    const storedBlocked = await dbUser(blocked.email);
    check("sign-up cannot set isBlocked / subscriptionPlan (refused, or ignored)", blocked.res.status !== 200 ? storedBlocked === null : storedBlocked?.isBlocked !== true && (storedBlocked?.subscriptionPlan ?? "free") === "free", [blocked.res.status, storedBlocked]);
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
