/**
 * Checks the Stripe Premium subscription end to end over real HTTP: `npm run verify:stripe`.
 *
 * What is REAL here: the Express app, Better Auth sign-up and JWTs, MongoDB (transactions included),
 * the real Stripe SDK, and the real signature check (Stripe.webhooks.constructEvent): webhook
 * requests are signed with the SDK's own signer using a TEST signing secret.
 *
 * What is NOT real: Stripe itself. The SDK is pointed at a small stand-in for the Stripe API that
 * runs inside this script, and the events are written by hand in the shape of Stripe's current
 * objects. So this proves how THIS server behaves; it does not prove that your Stripe account, Price
 * or webhook endpoint are configured correctly. That needs Stripe test mode (docs/STRIPE_SUBSCRIPTION_TESTING.md).
 *
 * It never touches your real data: DB_NAME is a throwaway database that is dropped at the end, and
 * the Stripe values below are fakes that exist only in this process.
 */
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

// Fakes, built from pieces so that no secret scanner mistakes them for real Stripe credentials.
const FAKE_KEY = ["sk", "test", "verifyfake0123456789"].join("_");
const FAKE_SECRET = ["whsec", "verifyfake0123456789"].join("_");
const FAKE_PRICE = ["price", "verifyfake01"].join("_");

// ===================================================================== child: env validation
if (process.env.STRIPE_ENV_CHILD) {
  await import("../config/env.js");
  console.log("ENV_OK");
  process.exit(0);
}

process.env.DB_NAME = `pizzahub_stripe_verify_${Date.now()}`;
process.env.STRIPE_SECRET_KEY = FAKE_KEY;
process.env.STRIPE_WEBHOOK_SECRET = FAKE_SECRET;
process.env.STRIPE_PREMIUM_PRICE_ID = FAKE_PRICE;

const { default: Stripe } = await import("stripe");
const { ObjectId } = await import("mongodb");
const { default: app } = await import("../app.js");
const { env } = await import("../config/env.js");
const { client, connectDB, getDB } = await import("../config/db.js");
const { initializeDatabase } = await import("../config/initDatabase.js");
const { overrideStripeClientForTests } = await import("../lib/stripe.js");
const { menuItemsCollection, transactionsCollection, usersCollection } = await import("../models/index.js");

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

// biome-ignore lint: test helper, objects are checked field by field below
type Json = any;
type Res = { status: number; body: Json };
type Id = InstanceType<typeof ObjectId>;

// ===================================================================== the stand-in for Stripe's API
const DAY = 86_400;
const nowSec = () => Math.floor(Date.now() / 1000);

const fake = {
  customers: new Map<string, Json>(),
  sessions: new Map<string, Json>(),
  subs: new Map<string, Json>(),
  idempotent: new Map<string, Json>(),
  created: { customers: 0, sessions: 0 },
  createParams: [] as URLSearchParams[],
  cancelled: [] as string[],
  failSubscriptionReads: false,
  counter: 0,
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "request-id": "req_fake" });
  res.end(JSON.stringify(body));
};

const list = (data: unknown[]) => ({ object: "list", data, has_more: false, url: "/v1/list" });

const stripeStandIn = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://stand-in");
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const key = req.headers["idempotency-key"];
    const path = url.pathname;

    if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) return send(res, 401, { error: { type: "invalid_request_error", message: "bad key" } });

    if (req.method === "POST" && path === "/v1/customers") {
      if (typeof key === "string" && fake.idempotent.has(key)) return send(res, 200, fake.idempotent.get(key));
      const customer = { id: `cus_fake_${++fake.counter}`, object: "customer", email: form.get("email"), name: form.get("name"), metadata: { vendorId: form.get("metadata[vendorId]") } };
      fake.customers.set(customer.id, customer);
      fake.created.customers++;
      if (typeof key === "string") fake.idempotent.set(key, customer);
      return send(res, 200, customer);
    }

    if (req.method === "POST" && path === "/v1/checkout/sessions") {
      if (typeof key === "string" && fake.idempotent.has(key)) return send(res, 200, fake.idempotent.get(key));
      const id = `cs_test_fake_${++fake.counter}`;
      const session = {
        id,
        object: "checkout.session",
        mode: form.get("mode"),
        customer: form.get("customer"),
        client_reference_id: form.get("client_reference_id"),
        metadata: { vendorId: form.get("metadata[vendorId]"), plan: form.get("metadata[plan]") },
        status: "open",
        payment_status: "unpaid",
        subscription: null,
        amount_total: 1999, // what the Price says: the stand-in plays Stripe, the server never sends an amount
        currency: "usd",
        url: `https://checkout.stripe.test/c/pay/${id}`,
      };
      fake.sessions.set(id, session);
      fake.created.sessions++;
      fake.createParams.push(form);
      if (typeof key === "string") fake.idempotent.set(key, session);
      return send(res, 200, session);
    }

    const sessionMatch = /^\/v1\/checkout\/sessions\/(\w+)$/.exec(path);
    if (req.method === "GET" && sessionMatch) {
      const session = fake.sessions.get(sessionMatch[1]!);
      return session ? send(res, 200, session) : send(res, 404, { error: { type: "invalid_request_error", message: "No such session" } });
    }

    if (req.method === "GET" && path === "/v1/checkout/sessions") {
      const sub = url.searchParams.get("subscription");
      return send(res, 200, list([...fake.sessions.values()].filter((s) => s.subscription === sub)));
    }

    const subMatch = /^\/v1\/subscriptions\/(\w+)$/.exec(path);
    if (subMatch) {
      const sub = fake.subs.get(subMatch[1]!);
      if (req.method === "GET") {
        if (fake.failSubscriptionReads) return send(res, 500, { error: { type: "api_error", message: "boom" } });
        return sub ? send(res, 200, sub) : send(res, 404, { error: { type: "invalid_request_error", message: "No such subscription" } });
      }
      if (req.method === "DELETE" && sub) {
        fake.cancelled.push(sub.id);
        sub.status = "canceled";
        sub.ended_at = nowSec();
        return send(res, 200, sub);
      }
    }

    return send(res, 404, { error: { type: "invalid_request_error", message: `stand-in has no ${req.method} ${path}` } });
  });
});

await new Promise<void>((resolve) => stripeStandIn.listen(0, "127.0.0.1", resolve));
const standInPort = (stripeStandIn.address() as { port: number }).port;

overrideStripeClientForTests(
  new Stripe(FAKE_KEY, { host: "127.0.0.1", port: String(standInPort), protocol: "http", maxNetworkRetries: 0 })
);

// ===================================================================== helpers
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
  const text = await response.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body: parsed };
};

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

const CHECKOUT = "/api/vendor/subscription/checkout";
const SUBSCRIPTION = "/api/vendor/subscription";
const WEBHOOK = "/api/stripe/webhook";

// ---- events, shaped like Stripe's current objects
const makeSub = (id: string, vendor: Id | string, customer: string, over: Json = {}) => ({
  id,
  object: "subscription",
  status: "active",
  customer,
  metadata: { vendorId: String(vendor), plan: "premium" },
  cancel_at_period_end: false,
  ended_at: null,
  items: {
    object: "list",
    data: [{ id: `si_${id}`, object: "subscription_item", current_period_end: nowSec() + 30 * DAY, price: { id: FAKE_PRICE } }],
    has_more: false,
    url: "/v1/subscription_items",
  },
  ...over,
});

const setPeriodEnd = (sub: Json, endSec: number) => {
  sub.items.data[0].current_period_end = endSec;
};

const invoice = (subId: string, over: Json = {}, periodEnd = nowSec() + 30 * DAY) => ({
  id: `in_fake_${++fake.counter}`,
  object: "invoice",
  amount_paid: 1999,
  amount_due: 1999,
  currency: "usd",
  billing_reason: "subscription_cycle",
  parent: { type: "subscription_details", subscription_details: { subscription: subId } },
  lines: { object: "list", data: [{ id: "il_1", object: "line_item", period: { start: nowSec(), end: periodEnd } }], has_more: false, url: "/v1/lines" },
  ...over,
});

const completedSession = (sessionId: string, subId: string, over: Json = {}) => ({
  ...fake.sessions.get(sessionId),
  status: "complete",
  payment_status: "paid",
  subscription: subId,
  ...over,
});

const signedHeader = (payload: string, secret = FAKE_SECRET, timestamp?: number) =>
  Stripe.webhooks.generateTestHeaderString({ payload, secret, ...(timestamp ? { timestamp } : {}) });

const rawWebhook = async (payload: string, headers: Record<string, string>) => {
  const response = await fetch(baseUrl + WEBHOOK, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload });
  const text = await response.text();
  let body: Json = {};
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body } as Res;
};

const eventPayload = (type: string, object: Json, id = `evt_fake_${++fake.counter}`) =>
  JSON.stringify({ id, object: "event", api_version: "2026-11-18.endive", created: nowSec(), type, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object } });

/** A correctly signed event, as Stripe would send it. */
const webhook = (type: string, object: Json, id?: string) => {
  const payload = eventPayload(type, object, id);
  return rawWebhook(payload, { "stripe-signature": signedHeader(payload) });
};

const userOf = (id: Id) => usersCollection().findOne({ _id: id });
const txOf = (vendor: Id) => transactionsCollection().find({ vendorId: vendor }).sort({ createdAt: 1 }).toArray();
const txCount = () => transactionsCollection().countDocuments();
const secretsIn = (value: unknown) => /sk_test_|sk_live_|whsec_|cus_fake|price_verifyfake/.test(JSON.stringify(value));

/** Starts a checkout as `vendor` and returns the stored session and pending transaction. */
const startCheckout = async (vendor: TestUser) => {
  const res = await call("POST", CHECKOUT, vendor.token, {});
  if (res.status !== 201 && res.status !== 200) throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { res, sessionId: res.body.data.sessionId as string };
};

const server = app.listen(0);

try {
  await connectDB();
  await initializeDatabase();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  section("Setting up real users (sign-up + JWT)");
  const [vendorA, vendorB, vendorC, vendorD, vendorE, vendorF, customer, admin, blockedVendor] = await Promise.all([
    makeUser("vendora", "vendor"),
    makeUser("vendorb", "vendor"),
    makeUser("vendorc", "vendor"),
    makeUser("vendord", "vendor"),
    makeUser("vendore", "vendor"),
    makeUser("vendorf", "vendor"),
    makeUser("customer", "customer"),
    makeUser("admin", "customer"),
    makeUser("blockedvendor", "vendor"),
  ]);
  await usersCollection().updateOne({ _id: admin.id }, { $set: { role: "admin" } });
  await usersCollection().updateOne({ _id: blockedVendor.id }, { $set: { isBlocked: true } });
  check("9 users created with tokens", [vendorA, vendorB, vendorC, vendorD, vendorE, vendorF, customer, admin, blockedVendor].every((u) => u.token.length > 20));

  // ------------------------------------------------------------ 1. configuration
  section("1. Stripe configuration is validated when the server starts");
  {
    const run = (extra: Record<string, string>) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", self], {
        env: { ...process.env, STRIPE_ENV_CHILD: "1", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", STRIPE_PREMIUM_PRICE_ID: "", ...extra },
        encoding: "utf8",
      });
      return { code: result.status, out: `${result.stdout}${result.stderr}` };
    };

    const dev = run({ NODE_ENV: "development" });
    check("development without any Stripe value: the server still starts", dev.code === 0 && dev.out.includes("ENV_OK"), dev.out.slice(0, 300));
    const prod = run({ NODE_ENV: "production" });
    check("production without Stripe values: refuses to start, names all three", prod.code !== 0 && /STRIPE_SECRET_KEY/.test(prod.out) && /STRIPE_WEBHOOK_SECRET/.test(prod.out) && /STRIPE_PREMIUM_PRICE_ID/.test(prod.out), prod.out.slice(0, 400));
    const prodOk = run({ NODE_ENV: "production", STRIPE_SECRET_KEY: FAKE_KEY, STRIPE_WEBHOOK_SECRET: FAKE_SECRET, STRIPE_PREMIUM_PRICE_ID: FAKE_PRICE });
    check("production with all three valid: starts", prodOk.code === 0 && prodOk.out.includes("ENV_OK"), prodOk.out.slice(0, 300));
    const prodPartial = run({ NODE_ENV: "production", STRIPE_SECRET_KEY: FAKE_KEY, STRIPE_WEBHOOK_SECRET: FAKE_SECRET });
    check("production missing only the Price id: refuses, names it", prodPartial.code !== 0 && /STRIPE_PREMIUM_PRICE_ID/.test(prodPartial.out), prodPartial.out.slice(0, 300));

    for (const [name, value] of [["STRIPE_SECRET_KEY", "not-a-key"], ["STRIPE_WEBHOOK_SECRET", "secret123"], ["STRIPE_PREMIUM_PRICE_ID", "prod_abc"]] as const) {
      const bad = run({ NODE_ENV: "development", [name]: value });
      check(`${name}=${value} (wrong format) is refused at start-up`, bad.code !== 0 && bad.out.includes(name), bad.out.slice(0, 300));
    }
  }

  // ------------------------------------------------------------ 2. access
  section("2. Who may use the subscription endpoints");
  {
    const probes: [string, string, unknown][] = [["POST", CHECKOUT, {}], ["GET", SUBSCRIPTION, undefined]];

    for (const [method, path, body] of probes) {
      const label = `${method} ${path}`;
      const anon = await call(method, path, null, body);
      check(`${label} without login -> 401 NO_CREDENTIALS`, anon.status === 401 && anon.body.code === "NO_CREDENTIALS", anon.body);
      const cust = await call(method, path, customer.token, body);
      check(`${label} as customer -> 403 FORBIDDEN`, cust.status === 403 && cust.body.code === "FORBIDDEN", cust.body);
      const adm = await call(method, path, admin.token, body);
      check(`${label} as admin -> 403 FORBIDDEN`, adm.status === 403 && adm.body.code === "FORBIDDEN", adm.body);
      const blk = await call(method, path, blockedVendor.token, body);
      check(`${label} as blocked vendor -> 403 ACCOUNT_BLOCKED`, blk.status === 403 && blk.body.code === "ACCOUNT_BLOCKED", blk.body);
    }

    check("bad token -> 401 INVALID_TOKEN", (await call("GET", SUBSCRIPTION, "not.a.jwt")).body.code === "INVALID_TOKEN");
    check("none of those calls reached Stripe or created anything", fake.created.sessions === 0 && fake.created.customers === 0 && (await txCount()) === 0);

    const csrf = await fetch(baseUrl + CHECKOUT, { method: "POST", headers: { cookie: vendorA.cookie, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    check("cookie POST from a foreign Origin -> 403 (CSRF guard), nothing created", csrf.status === 403 && fake.created.sessions === 0);
  }

  // ------------------------------------------------------------ 3. client cannot choose the price
  section("3. The client cannot choose the price, plan or vendor");
  {
    for (const body of [
      { priceId: "price_cheap" },
      { price: "price_cheap" },
      { amount: 1 },
      { currency: "eur" },
      { plan: "premium" },
      { vendorId: String(vendorB.id) },
      { successUrl: "https://evil.example" },
      { line_items: [{ price: "price_cheap" }] },
    ]) {
      const key = Object.keys(body)[0]!;
      const r = await call("POST", CHECKOUT, vendorA.token, body);
      check(`body {"${key}": ...} -> 400 VALIDATION_ERROR, nothing created`, r.status === 400 && r.body.code === "VALIDATION_ERROR" && r.body.errors?.some((e: Json) => e.field === key) && fake.created.sessions === 0, r.body);
    }
  }

  // ------------------------------------------------------------ 4. checkout
  section("4. Vendor starts a checkout");
  let sessionA = "";
  {
    const { res, sessionId } = await startCheckout(vendorA);
    sessionA = sessionId;
    check("-> 201 success, message set", res.status === 201 && res.body.success === true && typeof res.body.message === "string", res.body);
    check("data is { url, sessionId } and the url is Stripe's", Object.keys(res.body.data).sort().join() === "sessionId,url" && res.body.data.url === `https://checkout.stripe.test/c/pay/${sessionId}`, res.body.data);
    check("no key, secret, customer id or price id in the response", !secretsIn(res.body), res.body);

    const params = fake.createParams[0]!;
    const got = (name: string) => params.get(name);
    check("Stripe was asked for mode=subscription", got("mode") === "subscription");
    check("the price is the server's own STRIPE_PREMIUM_PRICE_ID, quantity 1", got("line_items[0][price]") === FAKE_PRICE && got("line_items[0][quantity]") === "1");
    check("no amount, currency or inline price was sent (Stripe decides them from the Price)", ![...params.keys()].some((k) => /unit_amount|price_data|amount|currency/.test(k)), [...params.keys()]);
    check("vendor identity is the logged-in user: client_reference_id and metadata", got("client_reference_id") === String(vendorA.id) && got("metadata[vendorId]") === String(vendorA.id) && got("metadata[plan]") === "premium");
    check("the subscription carries the vendor too (subscription_data.metadata)", got("subscription_data[metadata][vendorId]") === String(vendorA.id) && got("subscription_data[metadata][plan]") === "premium");
    const origin = new URL(env.CLIENT_URL).origin;
    check("success and cancel URLs are frontend routes on CLIENT_URL", got("success_url") === `${origin}/dashboard/vendor/subscription?checkout=success` && got("cancel_url") === `${origin}/dashboard/vendor/subscription?checkout=cancelled`, [got("success_url"), got("cancel_url")]);

    const user = await userOf(vendorA.id);
    check("a Stripe customer was created once and remembered", fake.created.customers === 1 && user?.stripeCustomerId === "cus_fake_1" && got("customer") === "cus_fake_1");
    check("the customer was created with the vendor's own email and metadata", fake.customers.get("cus_fake_1")?.email === vendorA.email && fake.customers.get("cus_fake_1")?.metadata.vendorId === String(vendorA.id));

    const [tx] = await txOf(vendorA.id);
    check("a PENDING transaction was recorded: plan, amount, currency, session, no subscription yet", (await txOf(vendorA.id)).length === 1 && tx!.status === "pending" && tx!.plan === "premium" && tx!.amount === 19.99 && tx!.currency === "usd" && tx!.stripeSessionId === sessionId && tx!.stripeSubscriptionId === null, tx);

    // The customer is sent to Stripe, pays, and lands on the success URL. The server has no route for that
    // page: only the webhook can activate Premium. Asking for the status any number of times changes nothing.
    const status1 = await call("GET", SUBSCRIPTION, vendorA.token);
    await call("GET", SUBSCRIPTION, vendorA.token);
    const afterRedirect = await userOf(vendorA.id);
    check("coming back from checkout (success redirect) does NOT activate Premium", status1.body.data.subscriptionPlan === "free" && afterRedirect?.subscriptionPlan === "free" && !afterRedirect.stripeSubscriptionId && (await txOf(vendorA.id))[0]!.status === "pending", status1.body);

    // a second click reuses the open session
    const again = await call("POST", CHECKOUT, vendorA.token, {});
    check("a second click returns the SAME open session (200), no new session or customer", again.status === 200 && again.body.data.sessionId === sessionId && fake.created.sessions === 1 && fake.created.customers === 1, again.body);

    // four clicks at the same moment (a different vendor, so nothing is open yet)
    const burst = await Promise.all(Array.from({ length: 4 }, () => call("POST", CHECKOUT, vendorB.token, {})));
    const ids = new Set(burst.map((r) => r.body.data?.sessionId));
    check("4 checkout requests at the same moment -> one session, one customer, one pending transaction", burst.every((r) => r.status === 200 || r.status === 201) && ids.size === 1 && fake.created.sessions === 2 && fake.created.customers === 2 && (await txOf(vendorB.id)).length === 1, { statuses: burst.map((r) => r.status), ids: [...ids], sessions: fake.created.sessions });
  }

  // ------------------------------------------------------------ 5. signature
  section("5. The webhook only accepts events signed by Stripe");
  {
    const forged = eventPayload("checkout.session.completed", completedSession(sessionA, "sub_forged"));
    const before = { user: await userOf(vendorA.id), tx: await txCount() };

    const noHeader = await rawWebhook(forged, {});
    check("no Stripe-Signature header -> 400 INVALID_SIGNATURE", noHeader.status === 400 && noHeader.body.code === "INVALID_SIGNATURE", noHeader.body);
    const garbage = await rawWebhook(forged, { "stripe-signature": "not-a-signature" });
    check("garbage signature -> 400 INVALID_SIGNATURE", garbage.status === 400 && garbage.body.code === "INVALID_SIGNATURE", garbage.body);
    const wrongSecret = await rawWebhook(forged, { "stripe-signature": signedHeader(forged, ["whsec", "someoneelsessecret99"].join("_")) });
    check("signed with another secret -> 400 INVALID_SIGNATURE", wrongSecret.status === 400 && wrongSecret.body.code === "INVALID_SIGNATURE", wrongSecret.body);
    const tampered = await rawWebhook(forged.replace("sub_forged", "sub_tampered"), { "stripe-signature": signedHeader(forged) });
    check("valid signature but the body was changed afterwards -> 400", tampered.status === 400 && tampered.body.code === "INVALID_SIGNATURE", tampered.body);
    const replay = await rawWebhook(forged, { "stripe-signature": signedHeader(forged, FAKE_SECRET, nowSec() - 3600) });
    check("a correctly signed event that is an hour old (replay) -> 400", replay.status === 400 && replay.body.code === "INVALID_SIGNATURE", replay.body);
    const plain = await fetch(baseUrl + WEBHOOK, { method: "POST", headers: { "content-type": "text/plain", "stripe-signature": signedHeader(forged) }, body: forged });
    check("a body that is not application/json -> 400 (never treated as parsed JSON)", plain.status === 400);
    const afterForged = await userOf(vendorA.id);
    check("none of the rejected requests changed anything", afterForged?.subscriptionPlan === before.user?.subscriptionPlan && !afterForged?.stripeSubscriptionId && (await txCount()) === before.tx && fake.subs.size === 0);

    const getRoute = await call("GET", WEBHOOK, null);
    check("GET on the webhook URL is not a route -> 404", getRoute.status === 404);

    const unknown = await webhook("product.created", { id: "prod_1", object: "product" });
    check("a VALID signature is accepted: unknown event type -> 200 { received: true }, nothing changed", unknown.status === 200 && unknown.body.success === true && unknown.body.data.received === true && (await txCount()) === before.tx, unknown.body);
  }

  // ------------------------------------------------------------ 6. activation
  section("6. A verified payment activates Premium");
  const subA = makeSub("sub_a", vendorA.id, (await userOf(vendorA.id))!.stripeCustomerId!);
  fake.subs.set(subA.id, subA);
  const periodA = subA.items.data[0]!.current_period_end;
  let completedEventId = "";
  {
    completedEventId = "evt_completed_a";
    const res = await webhook("checkout.session.completed", completedSession(sessionA, "sub_a"), completedEventId);
    check("checkout.session.completed (paid) -> 200", res.status === 200 && res.body.data.received === true, res.body);

    const user = await userOf(vendorA.id);
    check("subscriptionPlan = premium", user?.subscriptionPlan === "premium");
    check("subscriptionExpiresAt = the end of the paid period from Stripe", user?.subscriptionExpiresAt instanceof Date && Math.floor(user.subscriptionExpiresAt.getTime() / 1000) === periodA, user?.subscriptionExpiresAt);
    check("subscription and customer references stored, status active, not cancelling", user?.stripeSubscriptionId === "sub_a" && user.stripeCustomerId === "cus_fake_1" && user.subscriptionStatus === "active" && user.subscriptionCancelAtPeriodEnd === false);

    const txs = await txOf(vendorA.id);
    check("the transaction is now success with the subscription id, amount 19.99 usd", txs.length === 1 && txs[0]!.status === "success" && txs[0]!.stripeSubscriptionId === "sub_a" && txs[0]!.amount === 19.99 && txs[0]!.currency === "usd" && txs[0]!.stripeSessionId === sessionA, txs);
    check("every stored transaction has all the required fields", Object.keys(txs[0]!).sort().join() === "_id,amount,createdAt,currency,plan,status,stripeSessionId,stripeSubscriptionId,vendorId", Object.keys(txs[0]!));

    const mine = await call("GET", SUBSCRIPTION, vendorA.token);
    check("GET /api/vendor/subscription: premium, active, expiry, subscription id", mine.status === 200 && mine.body.success === true && mine.body.data.subscriptionPlan === "premium" && mine.body.data.isPremium === true && mine.body.data.subscriptionStatus === "active" && mine.body.data.cancelAtPeriodEnd === false && mine.body.data.stripeSubscriptionId === "sub_a" && new Date(mine.body.data.subscriptionExpiresAt).getTime() === periodA * 1000, mine.body);
    check("response fields: subscriptionPlan,isPremium,subscriptionStatus,subscriptionExpiresAt,cancelAtPeriodEnd,stripeSubscriptionId", Object.keys(mine.body.data).sort().join() === "cancelAtPeriodEnd,isPremium,stripeSubscriptionId,subscriptionExpiresAt,subscriptionPlan,subscriptionStatus", Object.keys(mine.body.data));
    check("no Stripe key, webhook secret, price id or customer id anywhere in the response", !secretsIn(mine.body), mine.body);

    const session = await fetch(`${baseUrl}/api/auth/get-session`, { headers: { cookie: vendorA.cookie } });
    check("Better Auth's own session endpoint does not leak the Stripe references", !/stripe|sub_a|cus_fake/i.test(await session.text()));

    // Premium really changes what the vendor can do: more than 3 active items
    const body = (n: number) => ({ itemName: `Premium pizza ${n}`, category: "Pizza", description: "Hot", price: 10, location: "Dhaka", images: ["https://example.com/a.jpg"] });
    const created = [];
    for (let n = 1; n <= 4; n++) created.push((await call("POST", "/api/vendor/menu-items", vendorA.token, body(n))).status);
    check("a Premium vendor can now create a 4th active item (Free would stop at 3)", created.join() === "201,201,201,201", created);

    const dup = await call("POST", CHECKOUT, vendorA.token, {});
    check("a Premium vendor cannot start another checkout -> 409 ALREADY_PREMIUM, no new session", dup.status === 409 && dup.body.code === "ALREADY_PREMIUM" && fake.created.sessions === 2, dup.body);
  }

  // ------------------------------------------------------------ 7. duplicates
  section("7. The same event delivered again (retries, parallel deliveries)");
  {
    const before = await userOf(vendorA.id);
    const txBefore = await txCount();
    const payload = eventPayload("checkout.session.completed", completedSession(sessionA, "sub_a"), completedEventId);
    const headers = { "stripe-signature": signedHeader(payload) };

    const again = await rawWebhook(payload, headers);
    check("the identical event again -> 200", again.status === 200, again.body);
    const burst = await Promise.all(Array.from({ length: 6 }, () => rawWebhook(payload, headers)));
    check("6 identical deliveries at the same moment -> all 200", burst.every((r) => r.status === 200), burst.map((r) => r.status));

    const after = await userOf(vendorA.id);
    check("still exactly ONE transaction for the session (no duplicate row)", (await txCount()) === txBefore && (await txOf(vendorA.id)).length === 1);
    check("the vendor's state is identical (plan, expiry, references)", after?.subscriptionPlan === before?.subscriptionPlan && after?.subscriptionExpiresAt?.getTime() === before?.subscriptionExpiresAt?.getTime() && after?.stripeSubscriptionId === before?.stripeSubscriptionId);
    check("the unique index on stripeSessionId is still there", Boolean((await getDB().collection("transactions").indexes()).find((i) => i.name === "transactions_stripeSessionId_uidx" && i.unique)));

    // the same session arriving at the same moment as a first delivery, for a vendor who has not been activated yet
    const { sessionId } = await startCheckout(vendorC);
    const subC = makeSub("sub_c", vendorC.id, (await userOf(vendorC.id))!.stripeCustomerId!);
    fake.subs.set(subC.id, subC);
    const racing = eventPayload("checkout.session.completed", completedSession(sessionId, "sub_c"), "evt_race_c");
    const racingHeaders = { "stripe-signature": signedHeader(racing) };
    const results = await Promise.all(Array.from({ length: 6 }, () => rawWebhook(racing, racingHeaders)));
    check("6 simultaneous FIRST deliveries -> no 5xx, one transaction, vendor active", results.every((r) => r.status === 200) && (await txOf(vendorC.id)).length === 1 && (await userOf(vendorC.id))?.subscriptionPlan === "premium", results.map((r) => r.status));
    check("...and that transaction is success", (await txOf(vendorC.id))[0]?.status === "success");
  }

  // ------------------------------------------------------------ 8. renewal
  section("8. Renewal (invoice.paid) extends the paid period, once");
  {
    const before = await userOf(vendorA.id);
    const newEnd = nowSec() + 60 * DAY;
    setPeriodEnd(fake.subs.get("sub_a")!, newEnd);

    const paid = invoice("sub_a", {}, newEnd);
    const res = await webhook("invoice.paid", paid);
    const after = await userOf(vendorA.id);
    check("invoice.paid -> 200 and the paid-until date moves to the end of the invoice's period", res.status === 200 && Math.floor(after!.subscriptionExpiresAt!.getTime() / 1000) === newEnd && after!.subscriptionExpiresAt!.getTime() > before!.subscriptionExpiresAt!.getTime(), after?.subscriptionExpiresAt);
    check("a renewal is not a new checkout: no new transaction", (await txOf(vendorA.id)).length === 1);

    await webhook("invoice.paid", paid);
    await webhook("invoice.paid", paid);
    check("the same invoice.paid again changes nothing", (await userOf(vendorA.id))!.subscriptionExpiresAt!.getTime() === after!.subscriptionExpiresAt!.getTime());

    await webhook("invoice.paid", invoice("sub_a", {}, nowSec() + 5 * DAY));
    check("an OLDER invoice arriving late does not shorten the paid period", (await userOf(vendorA.id))!.subscriptionExpiresAt!.getTime() === after!.subscriptionExpiresAt!.getTime());

    const free = await webhook("invoice.paid", invoice("sub_a", { amount_paid: 0 }, nowSec() + 200 * DAY));
    check("an invoice with nothing paid (amount_paid 0) is not a payment: ignored", free.status === 200 && (await userOf(vendorA.id))!.subscriptionExpiresAt!.getTime() === after!.subscriptionExpiresAt!.getTime());
  }

  // ------------------------------------------------------------ 9. updated
  section("9. customer.subscription.updated");
  {
    const sub = fake.subs.get("sub_a")!;
    const expiresBefore = (await userOf(vendorA.id))!.subscriptionExpiresAt!.getTime();

    sub.cancel_at_period_end = true;
    const res = await webhook("customer.subscription.updated", { ...sub });
    const user = await userOf(vendorA.id);
    check("the customer cancels (cancel_at_period_end) -> 200, flag stored, STILL premium until the paid period ends", res.status === 200 && user?.subscriptionCancelAtPeriodEnd === true && user.subscriptionPlan === "premium" && user.subscriptionExpiresAt!.getTime() === expiresBefore, user);
    const mine = await call("GET", SUBSCRIPTION, vendorA.token);
    check("GET shows cancelAtPeriodEnd true and still premium", mine.body.data.cancelAtPeriodEnd === true && mine.body.data.isPremium === true, mine.body.data);

    const stale = await webhook("customer.subscription.updated", { ...sub, cancel_at_period_end: false });
    check("a STALE event (says 'not cancelling') does not undo it: the server asks Stripe for the current state", stale.status === 200 && (await userOf(vendorA.id))?.subscriptionCancelAtPeriodEnd === true);

    sub.cancel_at_period_end = false;
    await webhook("customer.subscription.updated", { ...sub });
    check("the customer resumes -> flag cleared", (await userOf(vendorA.id))?.subscriptionCancelAtPeriodEnd === false);

    const other = await webhook("customer.subscription.updated", makeSub("sub_stranger", vendorB.id, "cus_fake_2"));
    check("an update for a subscription Stripe does not know -> 5xx so Stripe retries, nothing changed", other.status >= 500 && (await userOf(vendorB.id))?.subscriptionPlan === "free", other.status);
  }

  // ------------------------------------------------------------ 10. payment failure
  section("10. Payment failure");
  {
    const sub = fake.subs.get("sub_a")!;
    const before = await userOf(vendorA.id);

    // a renewal fails: Stripe moves to past_due and ALREADY shows the next, unpaid period
    sub.status = "past_due";
    setPeriodEnd(sub, nowSec() + 90 * DAY);
    const failed = await webhook("invoice.payment_failed", invoice("sub_a", { amount_paid: 0, billing_reason: "subscription_cycle" }, nowSec() + 90 * DAY));
    const user = await userOf(vendorA.id);
    check("invoice.payment_failed (renewal) -> 200, status past_due recorded", failed.status === 200 && user?.subscriptionStatus === "past_due", user?.subscriptionStatus);
    check("...Premium is NOT switched off by a failed payment (the paid period still counts)", user?.subscriptionPlan === "premium" && user.subscriptionExpiresAt!.getTime() === before!.subscriptionExpiresAt!.getTime());
    check("...and the unpaid next period is NOT granted", user!.subscriptionExpiresAt!.getTime() < (nowSec() + 90 * DAY) * 1000);
    check("a failed renewal creates no transaction", (await txOf(vendorA.id)).length === 1 && (await txOf(vendorA.id))[0]!.status === "success");

    await webhook("customer.subscription.updated", { ...sub });
    check("subscription.updated with past_due does not extend access either", (await userOf(vendorA.id))!.subscriptionExpiresAt!.getTime() === before!.subscriptionExpiresAt!.getTime() && (await userOf(vendorA.id))?.subscriptionStatus === "past_due");
    check("GET shows past_due", (await call("GET", SUBSCRIPTION, vendorA.token)).body.data.subscriptionStatus === "past_due");

    // the payment is fixed: invoice.paid brings it back
    sub.status = "active";
    await webhook("invoice.paid", invoice("sub_a", {}, nowSec() + 90 * DAY));
    await webhook("customer.subscription.updated", { ...sub });
    const fixed = await userOf(vendorA.id);
    check("after the retry succeeds (invoice.paid) it is active again and the period is extended", fixed?.subscriptionStatus === "active" && fixed.subscriptionExpiresAt!.getTime() > before!.subscriptionExpiresAt!.getTime());

    // the FIRST payment fails (vendor D): the checkout's transaction fails, no Premium
    const { sessionId } = await startCheckout(vendorD);
    const userD = await userOf(vendorD.id);
    const subD = makeSub("sub_d", vendorD.id, userD!.stripeCustomerId!, { status: "incomplete" });
    fake.subs.set(subD.id, subD);
    fake.sessions.get(sessionId)!.subscription = "sub_d"; // Stripe attaches the subscription to the session
    const firstFailed = await webhook("invoice.payment_failed", invoice("sub_d", { amount_paid: 0, billing_reason: "subscription_create" }));
    const txD = (await txOf(vendorD.id))[0]!;
    check("first payment failed -> the pending transaction becomes failed", firstFailed.status === 200 && txD.status === "failed" && txD.stripeSubscriptionId === "sub_d", txD);
    check("...and the vendor is NOT Premium", (await userOf(vendorD.id))?.subscriptionPlan === "free" && !(await userOf(vendorD.id))?.stripeSubscriptionId);

    // the customer retries on the same Checkout page and pays
    subD.status = "active";
    await webhook("checkout.session.completed", completedSession(sessionId, "sub_d"));
    check("the customer retries and pays: failed -> success, Premium active", (await txOf(vendorD.id))[0]!.status === "success" && (await userOf(vendorD.id))?.subscriptionPlan === "premium");
  }

  // ------------------------------------------------------------ 11. deleted
  section("11. Subscription ended: back to Free, nothing is deleted");
  {
    const sub = fake.subs.get("sub_a")!;
    sub.status = "canceled";
    sub.ended_at = nowSec();
    sub.cancel_at_period_end = false;

    const itemsBefore = await menuItemsCollection().countDocuments({ vendorId: vendorA.id });
    const res = await webhook("customer.subscription.deleted", { ...sub });
    const user = await userOf(vendorA.id);
    check("customer.subscription.deleted -> 200, plan is Free again", res.status === 200 && user?.subscriptionPlan === "free" && user.subscriptionStatus === "canceled", user);
    check("...paid access ends now (the expiry is not in the future)", user!.subscriptionExpiresAt!.getTime() <= Date.now() + 1000, user?.subscriptionExpiresAt);

    const mine = await call("GET", SUBSCRIPTION, vendorA.token);
    check("GET shows free, not premium, status canceled", mine.body.data.subscriptionPlan === "free" && mine.body.data.isPremium === false && mine.body.data.subscriptionStatus === "canceled", mine.body.data);

    check("the vendor's menu items were NOT deleted or changed", (await menuItemsCollection().countDocuments({ vendorId: vendorA.id })) === itemsBefore && itemsBefore === 4);
    const fifth = await call("POST", "/api/vendor/menu-items", vendorA.token, { itemName: "Fifth", category: "Pizza", description: "Hot", price: 10, location: "Dhaka", images: ["https://example.com/a.jpg"] });
    check("the Free plan limit still applies: a new item is refused (403 FREE_PLAN_LIMIT_REACHED)", fifth.status === 403 && fifth.body.code === "FREE_PLAN_LIMIT_REACHED", fifth.body);

    await webhook("customer.subscription.deleted", { ...sub });
    check("the same deleted event again changes nothing", (await userOf(vendorA.id))?.subscriptionPlan === "free");

    // a new checkout is possible again after the subscription ended
    const second = await call("POST", CHECKOUT, vendorA.token, {});
    check("after cancelling, the vendor may subscribe again -> 201 with a NEW session", second.status === 201 && second.body.data.sessionId !== sessionA, second.body);

    // an OLD subscription ending must not downgrade the vendor's CURRENT one
    const subB = makeSub("sub_b_current", vendorB.id, (await userOf(vendorB.id))!.stripeCustomerId!);
    fake.subs.set(subB.id, subB);
    const sessionB = [...fake.sessions.values()].find((s) => s.client_reference_id === String(vendorB.id))!.id as string;
    await webhook("checkout.session.completed", completedSession(sessionB, "sub_b_current"));
    check("(setup) vendor B is Premium on sub_b_current", (await userOf(vendorB.id))?.subscriptionPlan === "premium");
    const oldSub = makeSub("sub_b_old", vendorB.id, (await userOf(vendorB.id))!.stripeCustomerId!, { status: "canceled", ended_at: nowSec() });
    fake.subs.set(oldSub.id, oldSub);
    await webhook("customer.subscription.deleted", { ...oldSub });
    check("an OLDER subscription of the same vendor ending does not downgrade the current one", (await userOf(vendorB.id))?.subscriptionPlan === "premium" && (await userOf(vendorB.id))?.stripeSubscriptionId === "sub_b_current");

    // expiry without any event: the paid date passes
    await usersCollection().updateOne({ _id: vendorB.id }, { $set: { subscriptionExpiresAt: new Date(Date.now() - 1000) } });
    const expired = await call("GET", SUBSCRIPTION, vendorB.token);
    check("a Premium whose paid date has passed reads as free (never 'premium' past its end)", expired.body.data.subscriptionPlan === "free" && expired.body.data.isPremium === false, expired.body.data);
    const blocked = await call("POST", CHECKOUT, vendorB.token, {});
    check("...but while Stripe still has it live (active), a second checkout is refused -> 409 SUBSCRIPTION_EXISTS", blocked.status === 409 && blocked.body.code === "SUBSCRIPTION_EXISTS", blocked.body);
  }

  // ------------------------------------------------------------ 12. expired / cancelled checkouts
  section("12. Checkouts that were never paid");
  {
    const { sessionId } = await startCheckout(vendorE);
    fake.sessions.get(sessionId)!.status = "expired";
    const expired = await webhook("checkout.session.expired", { ...fake.sessions.get(sessionId) });
    check("checkout.session.expired -> the pending transaction becomes expired", expired.status === 200 && (await txOf(vendorE.id))[0]!.status === "expired");
    check("the vendor is still Free", (await userOf(vendorE.id))?.subscriptionPlan === "free");

    const next = await call("POST", CHECKOUT, vendorE.token, {});
    check("an expired session is not reused: a new checkout gets a NEW session (201)", next.status === 201 && next.body.data.sessionId !== sessionId, next.body);
    const txs = await txOf(vendorE.id);
    check("two transactions now: the expired one and a new pending one", txs.length === 2 && txs[0]!.status === "expired" && txs[1]!.status === "pending");

    // paid later than it should: unpaid completed session, then the subscription is cancelled
    const newSession = next.body.data.sessionId as string;
    const subE = makeSub("sub_e", vendorE.id, (await userOf(vendorE.id))!.stripeCustomerId!, { status: "incomplete" });
    fake.subs.set(subE.id, subE);
    await webhook("checkout.session.completed", completedSession(newSession, "sub_e", { payment_status: "unpaid" }));
    const stillPending = (await txOf(vendorE.id))[1]!;
    check("a completed session that is NOT paid yet does not activate Premium (stays pending, subscription noted)", stillPending.status === "pending" && stillPending.stripeSubscriptionId === "sub_e" && (await userOf(vendorE.id))?.subscriptionPlan === "free", stillPending);

    subE.status = "incomplete_expired";
    subE.ended_at = nowSec();
    await webhook("customer.subscription.deleted", { ...subE });
    check("its subscription expires unpaid -> transaction expired, still Free", (await txOf(vendorE.id))[1]!.status === "expired" && (await userOf(vendorE.id))?.subscriptionPlan === "free");

    const cancelled = await startCheckout(vendorF);
    const subF = makeSub("sub_f", vendorF.id, (await userOf(vendorF.id))!.stripeCustomerId!, { status: "incomplete" });
    fake.subs.set(subF.id, subF);
    await webhook("checkout.session.completed", completedSession(cancelled.sessionId, "sub_f", { payment_status: "unpaid" }));
    subF.status = "canceled";
    subF.ended_at = nowSec();
    await webhook("customer.subscription.deleted", { ...subF });
    check("a subscription cancelled before it was ever paid -> transaction cancelled", (await txOf(vendorF.id))[0]!.status === "cancelled");
  }

  // ------------------------------------------------------------ 13. unexpected data
  section("13. Unexpected or incomplete events never activate Premium");
  {
    const victim = vendorF; // Free, with a cancelled checkout
    const { sessionId } = await startCheckout(victim);
    const userV = (await userOf(victim.id))!;
    const base = fake.sessions.get(sessionId)!;

    const attempts: [string, string, Json, Json?][] = [
      ["subscription metadata has no vendorId", "sub_x1", { metadata: { plan: "premium" } }],
      ["subscription metadata has no plan", "sub_x2", { metadata: { vendorId: String(victim.id) } }],
      ["subscription metadata names a vendor that does not exist", "sub_x3", { metadata: { vendorId: String(new ObjectId()), plan: "premium" } }],
      ["subscription metadata is not an ObjectId", "sub_x4", { metadata: { vendorId: "'; drop", plan: "premium" } }],
      ["the subscription belongs to a different Stripe customer", "sub_x5", { customer: "cus_someone_else" }],
      ["client_reference_id names someone else", "sub_x6", {}, { client_reference_id: String(vendorB.id) }],
      ["session metadata names someone else", "sub_x7", {}, { metadata: { vendorId: String(vendorB.id), plan: "premium" } }],
      ["a paid session with amount_total 0", "sub_x8", {}, { amount_total: 0 }],
      ["a paid session without a currency", "sub_x9", {}, { currency: null }],
      ["a payment-mode session (not a subscription)", "sub_x10", {}, { mode: "payment" }],
      ["a session with no subscription id", "", {}, { subscription: null }],
    ];

    const txBefore = await txCount();

    for (const [name, subId, subOver, sessionOver] of attempts) {
      if (subId) fake.subs.set(subId, makeSub(subId, victim.id, userV.stripeCustomerId!, subOver));
      const r = await webhook("checkout.session.completed", { ...base, status: "complete", payment_status: "paid", subscription: subId || null, ...(sessionOver ?? {}) });
      const u = await userOf(victim.id);
      check(`${name} -> acknowledged (200) but Premium NOT activated`, r.status === 200 && u?.subscriptionPlan === "free" && !u.stripeSubscriptionId, { status: r.status, plan: u?.subscriptionPlan });
    }
    check("...and no transaction was created or changed by them", (await txCount()) === txBefore && (await txOf(victim.id)).every((t) => t.status !== "success"));

    const noPeriod = makeSub("sub_x11", victim.id, userV.stripeCustomerId!);
    noPeriod.items.data = [];
    fake.subs.set("sub_x11", noPeriod);
    const r = await webhook("checkout.session.completed", { ...base, status: "complete", payment_status: "paid", subscription: "sub_x11" });
    check("a subscription without a paid period -> not activated", r.status === 200 && (await userOf(victim.id))?.subscriptionPlan === "free");

    const badInvoice = await webhook("invoice.paid", { id: "in_x", object: "invoice", amount_paid: 1999, currency: "usd", lines: { data: [] }, parent: null });
    check("an invoice with no subscription -> ignored", badInvoice.status === 200 && (await userOf(victim.id))?.subscriptionPlan === "free");
  }

  // ------------------------------------------------------------ 14. second subscription
  section("14. A second subscription for a vendor who already has one");
  {
    // vendor C is Premium on sub_c. Somehow a second checkout of theirs is paid.
    const userC = (await userOf(vendorC.id))!;
    // A checkout is refused for a Premium vendor, so this second paid session is built as Stripe would
    // have had it if it had been opened before the first payment finished.
    const firstSession = [...fake.sessions.values()].find((s) => s.client_reference_id === String(vendorC.id))!;
    const sessionId = "cs_test_fake_second";
    fake.sessions.set(sessionId, { ...firstSession, id: sessionId });
    const subSecond = makeSub("sub_c_second", vendorC.id, userC.stripeCustomerId!);
    fake.subs.set(subSecond.id, subSecond);

    const res = await webhook("checkout.session.completed", completedSession(sessionId, "sub_c_second"));
    const user = await userOf(vendorC.id);
    check("it is acknowledged, but the vendor keeps their ONE subscription (sub_c)", res.status === 200 && user?.stripeSubscriptionId === "sub_c" && user.subscriptionPlan === "premium", { status: res.status, sub: user?.stripeSubscriptionId });
    check("the extra subscription was cancelled at Stripe so it is not billed again", fake.cancelled.includes("sub_c_second"));
    const tx = (await transactionsCollection().findOne({ stripeSessionId: sessionId }))!;
    check("its transaction is recorded as cancelled (never success)", tx.status === "cancelled" && tx.stripeSubscriptionId === "sub_c_second", tx);
  }

  // ------------------------------------------------------------ 15. failure while handling
  section("15. If handling fails, Stripe is told to retry and nothing is half-done");
  {
    const g = await makeUser("vendorg", "vendor");
    const { sessionId } = await startCheckout(g);
    const subG = makeSub("sub_g", g.id, (await userOf(g.id))!.stripeCustomerId!);
    fake.subs.set(subG.id, subG);

    fake.failSubscriptionReads = true;
    const failed = await webhook("checkout.session.completed", completedSession(sessionId, "sub_g"));
    fake.failSubscriptionReads = false;
    check("Stripe's API fails while handling -> 500 (Stripe will retry), no details leaked", failed.status === 500 && failed.body.message === "Internal server error" && !JSON.stringify(failed.body).includes("boom"), failed.body);
    check("nothing was half-applied: still Free, transaction still pending", (await userOf(g.id))?.subscriptionPlan === "free" && (await txOf(g.id))[0]!.status === "pending");

    const retry = await webhook("checkout.session.completed", completedSession(sessionId, "sub_g"));
    check("the retry succeeds: Premium and success together", retry.status === 200 && (await userOf(g.id))?.subscriptionPlan === "premium" && (await txOf(g.id))[0]!.status === "success");
  }

  // ------------------------------------------------------------ 16. nothing else changed
  section("16. The rest of the API is untouched by the raw webhook body");
  {
    check("/api/health still 200", (await call("GET", "/api/health", null)).status === 200);
    check("public menu still 200", (await call("GET", "/api/menu-items", null)).status === 200);
    const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: env.CLIENT_URL }, body: JSON.stringify({ email: vendorA.email, password: PASSWORD }) });
    check("Better Auth sign-in with a JSON body still works", signIn.status === 200);
    const jsonBody = await call("POST", "/api/vendor/menu-items", vendorB.token, { itemName: "JSON body works", category: "Pizza", description: "Hot", price: 10, location: "Dhaka", images: ["https://example.com/a.jpg"] });
    check("a JSON body on another route is still parsed (express.json is unchanged)", jsonBody.status === 201, jsonBody.body);
    const badJson = await call("POST", "/api/vendor/menu-items", vendorB.token, "{ not json");
    check("broken JSON on another route is still a clean 400", badJson.status === 400 && badJson.body.success === false, badJson.body);
    check("vendor menu / orders still 200 for a vendor, 403 for a customer", (await call("GET", "/api/vendor/orders", vendorA.token)).status === 200 && (await call("GET", "/api/vendor/menu-items", customer.token)).status === 403);

    for (const [method, path] of [["PATCH", "/api/admin/transactions/x"], ["POST", "/api/admin/transactions"], ["DELETE", "/api/admin/transactions/x"], ["GET", "/api/transactions"], ["PATCH", "/api/vendor/transactions/x"]] as const) {
      const r = await call(method, path, admin.token, method === "GET" ? undefined : {});
      check(`${method} ${path}: no such route (an admin cannot edit transactions) -> 404`, r.status === 404, r.status);
    }
  }
} catch (error) {
  failures.push("script crashed");
  console.error("\nScript crashed:", error);
} finally {
  server.close();
  stripeStandIn.close();
  overrideStripeClientForTests(undefined);

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
