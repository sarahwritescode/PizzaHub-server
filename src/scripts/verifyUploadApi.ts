/**
 * Checks POST /api/vendor/upload-image end to end over real HTTP: `npm run verify:upload`.
 *
 * Real sign-up and real Better Auth JWTs in a throwaway database (dropped at the
 * end), real multipart uploads through the real Express app.
 *
 * What is NOT real: no real ImgBB API key is available to this script, so the
 * "successful upload" cases talk to a STAND-IN for ImgBB (global fetch is
 * replaced for api.imgbb.com only, answering in the shape documented at
 * https://api.imgbb.com/). Those cases prove OUR code, not that ImgBB accepts the
 * upload. The one exception is the invalid-key case, which calls the REAL ImgBB
 * with a junk key and a 8-byte "image" and expects its real 400 / code 100 answer.
 * A real successful upload can only be checked by you, with your own key (see
 * docs/IMAGE_UPLOAD_TESTING.md).
 */
process.env.DB_NAME = `pizzahub_upload_verify_${Date.now()}`;

const { ObjectId } = await import("mongodb");
const { default: app } = await import("../app.js");
const { env } = await import("../config/env.js");
const { client, connectDB, getDB } = await import("../config/db.js");
const { initializeDatabase } = await import("../config/initDatabase.js");
const { menuItemsCollection, usersCollection } = await import("../models/index.js");

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

// ------------------------------------------------------------------ fixtures
// Smallest valid files of each type (real magic bytes).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64"
);
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** `head` followed by zero padding, to reach an exact size. */
const padded = (head: Buffer, size: number) => Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
const MB = 1024 * 1024;

let baseUrl = "";
const PASSWORD = "Passw0rdOK";
const runId = Date.now();

interface TestUser {
  token: string;
  id: InstanceType<typeof ObjectId>;
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
  return { token, id: user!._id };
};

interface Part {
  name?: string;
  filename?: string;
  type?: string;
  data: Buffer;
}

const upload = async (token: string | null, parts: Part[], extraHeaders: Record<string, string> = {}): Promise<Res> => {
  const form = new FormData();
  for (const part of parts) {
    form.append(
      part.name ?? "images",
      new Blob([new Uint8Array(part.data)], { type: part.type ?? "image/jpeg" }),
      part.filename ?? "photo.jpg"
    );
  }

  const headers: Record<string, string> = { ...extraHeaders };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}/api/vendor/upload-image`, { method: "POST", headers, body: form });
  return { status: response.status, body: await response.json() };
};

const jsonCall = async (method: string, path: string, token: string, body?: unknown): Promise<Res> => {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

// ------------------------------------------- ImgBB stand-in (api.imgbb.com only)
const realFetch = globalThis.fetch;
const STUB_KEY = "stand-in-key-0123456789"; // not a real key: only ever sent to the stand-in

interface SeenCall {
  url: string;
  key: string | null;
  field: string | null;
  filename: string;
  mime: string;
  size: number;
}

let provider: "stub" | "real" = "stub";
let stubBehavior: (call: SeenCall) => Response | Promise<Response> = (call) => okResponse(call);
const seen: SeenCall[] = [];
const loggedErrors: string[] = [];

const okResponse = (call: SeenCall): Response => {
  const id = `id${seen.length}`;
  return Response.json({
    data: {
      id,
      title: "t",
      url_viewer: `https://ibb.co/${id}`,
      url: `https://i.ibb.co/${id}/${call.filename}`,
      display_url: `https://i.ibb.co/${id}d/${call.filename}`,
      delete_url: `https://ibb.co/${id}/SECRETDELETETOKEN`,
      image: { url: `https://i.ibb.co/${id}/${call.filename}` },
    },
    success: true,
    status: 200,
  });
};

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  if (provider === "real" || !url.startsWith("https://api.imgbb.com/")) {
    return realFetch(input, init);
  }

  const form = init?.body as FormData;
  const file = form.get("image") as File | null;
  const call: SeenCall = {
    url,
    key: new URL(url).searchParams.get("key"),
    field: file ? "image" : null,
    filename: file?.name ?? "",
    mime: file?.type ?? "",
    size: file?.size ?? 0,
  };
  seen.push(call);
  return stubBehavior(call);
}) as typeof fetch;

const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  loggedErrors.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
};

const reset = () => {
  seen.length = 0;
  loggedErrors.length = 0;
  stubBehavior = (call) => okResponse(call);
};

const server = app.listen(0);

try {
  await connectDB();
  await initializeDatabase();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  section("Setting up real users (sign-up + JWT)");
  const [vendor, customer, adminUser, blocked] = await Promise.all([
    makeUser("uploadVendor", "vendor"),
    makeUser("uploadCustomer", "customer"),
    makeUser("uploadAdmin", "customer"),
    makeUser("uploadBlocked", "vendor"),
  ]);
  await usersCollection().updateOne({ _id: adminUser.id }, { $set: { role: "admin" } });
  await usersCollection().updateOne({ _id: blocked.id }, { $set: { isBlocked: true } });
  check("4 users created with tokens", [vendor, customer, adminUser, blocked].every((u) => u.token.length > 20));

  // ---------------------------------------------------------- not configured
  section("1. No IMGBB_API_KEY configured");
  {
    (env as { IMGBB_API_KEY?: string }).IMGBB_API_KEY = undefined;
    reset();
    const res = await upload(vendor.token, [{ data: JPEG }]);
    check("vendor -> 503 UPLOAD_NOT_CONFIGURED", res.status === 503 && res.body.code === "UPLOAD_NOT_CONFIGURED", res.body);
    check("error shape is { success:false, message, code }", res.body.success === false && typeof res.body.message === "string");
    check("nothing was sent to ImgBB", seen.length === 0);

    const badFile = await upload(vendor.token, [{ data: GIF, filename: "a.gif", type: "image/gif" }]);
    check("an invalid file is still reported as 415 (validation runs before the config check)", badFile.status === 415, badFile.body);
    const big = await upload(vendor.token, [{ data: padded(JPEG, 5 * MB + 1) }]);
    check("an oversized file is still reported as 413 without a key", big.status === 413, big.body);

    const anon = await upload(null, [{ data: JPEG }]);
    check("anonymous still gets 401 first (auth runs before the config check)", anon.status === 401, anon.body);
  }

  (env as { IMGBB_API_KEY?: string }).IMGBB_API_KEY = STUB_KEY;

  // ------------------------------------------------------------ access control
  section("2. Access control (nothing may reach ImgBB)");
  {
    reset();
    const anon = await upload(null, [{ data: JPEG }]);
    check("no login -> 401 NO_CREDENTIALS", anon.status === 401 && anon.body.code === "NO_CREDENTIALS", anon.body);
    const bad = await upload("not.a.jwt", [{ data: JPEG }]);
    check("garbage token -> 401 INVALID_TOKEN", bad.status === 401 && bad.body.code === "INVALID_TOKEN", bad.body);
    const cust = await upload(customer.token, [{ data: JPEG }]);
    check("customer -> 403 FORBIDDEN", cust.status === 403 && cust.body.code === "FORBIDDEN", cust.body);
    const admin = await upload(adminUser.token, [{ data: JPEG }]);
    check("admin -> 403 FORBIDDEN", admin.status === 403 && admin.body.code === "FORBIDDEN", admin.body);
    const block = await upload(blocked.token, [{ data: JPEG }]);
    check("blocked vendor -> 403 ACCOUNT_BLOCKED", block.status === 403 && block.body.code === "ACCOUNT_BLOCKED", block.body);
    check("ImgBB was never called", seen.length === 0, seen);
  }

  // ---------------------------------------------------------------- valid uploads
  section("3. Valid uploads (JPEG, JPG, PNG, WEBP)");
  {
    reset();
    const jpeg = await upload(vendor.token, [{ data: JPEG, filename: "pizza.jpeg", type: "image/jpeg" }]);
    check("JPEG -> 201", jpeg.status === 201 && jpeg.body.success === true, jpeg.body);
    check(
      "response is { data: { images: [{ url, display_url }] } }",
      Array.isArray(jpeg.body.data?.images) &&
        jpeg.body.data.images.length === 1 &&
        typeof jpeg.body.data.images[0].url === "string" &&
        typeof jpeg.body.data.images[0].display_url === "string",
      jpeg.body
    );
    check("url is https", jpeg.body.data.images[0].url.startsWith("https://"));

    const jpg = await upload(vendor.token, [{ data: JPEG, filename: "pizza.jpg", type: "image/jpg" }]);
    check("JPG (image/jpg) -> 201", jpg.status === 201, jpg.body);
    const png = await upload(vendor.token, [{ data: PNG, filename: "pizza.png", type: "image/png" }]);
    check("PNG -> 201", png.status === 201, png.body);
    const webp = await upload(vendor.token, [{ data: WEBP, filename: "pizza.webp", type: "image/webp" }]);
    check("WEBP -> 201", webp.status === 201, webp.body);

    check("4 calls reached ImgBB", seen.length === 4);
    check(
      "ImgBB got the real type of each file",
      seen[0]!.mime === "image/jpeg" && seen[2]!.mime === "image/png" && seen[3]!.mime === "image/webp",
      seen.map((s) => s.mime)
    );
    check("file was sent in the `image` field", seen.every((s) => s.field === "image"));
    check("API key was sent to ImgBB (query string)", seen.every((s) => s.key === STUB_KEY));
    check(
      "client filename is NOT forwarded; a generated name with the right extension is used",
      seen.every((s) => /^pizzahub-[0-9a-f-]{36}\.(jpg|png|webp)$/.test(s.filename)) && !seen.some((s) => s.filename.includes("pizza.")),
      seen.map((s) => s.filename)
    );

    const all = JSON.stringify([jpeg.body, jpg.body, png.body, webp.body]);
    check("the API key is not in any response", !all.includes(STUB_KEY));
    check("delete_url is not exposed", !all.includes("SECRETDELETETOKEN") && !all.includes("delete_url"));
    check("the API key is not in any log line", !loggedErrors.join("\n").includes(STUB_KEY), loggedErrors);

    reset();
    const lying = await upload(vendor.token, [{ data: JPEG, filename: "notes.txt", type: "image/jpeg" }]);
    check("real JPEG content with an odd file name is accepted (content is what counts)", lying.status === 201, lying.body);
    check("...and still sent with a .jpg name", /\.jpg$/.test(seen[0]?.filename ?? ""));

    reset();
    const exact = await upload(vendor.token, [{ data: padded(JPEG, 5 * MB) }]);
    check("exactly 5 MB -> accepted", exact.status === 201, exact.body);
    check("...and all 5 MB reached ImgBB", seen[0]?.size === 5 * MB, seen[0]?.size);
  }

  // ------------------------------------------------------------------ multiple
  section("4. Multiple images");
  {
    reset();
    const three = await upload(vendor.token, [
      { data: JPEG, filename: "a.jpg", type: "image/jpeg" },
      { data: PNG, filename: "b.png", type: "image/png" },
      { data: WEBP, filename: "c.webp", type: "image/webp" },
    ]);
    check("3 images -> 201 with 3 results", three.status === 201 && three.body.data.images.length === 3, three.body);
    check("message is plural", three.body.message === "Images uploaded successfully", three.body.message);
    const urls = three.body.data.images.map((i: { url: string }) => i.url);
    check("3 different URLs", new Set(urls).size === 3, urls);
    check("order matches the request (jpeg, png, webp)", urls[0].endsWith(".jpg") && urls[1].endsWith(".png") && urls[2].endsWith(".webp"), urls);

    reset();
    const five = await upload(vendor.token, Array.from({ length: 5 }, (_, i) => ({ data: JPEG, filename: `f${i}.jpg` })));
    check("exactly 5 images -> 201", five.status === 201 && five.body.data.images.length === 5, five.body);

    reset();
    const six = await upload(vendor.token, Array.from({ length: 6 }, (_, i) => ({ data: JPEG, filename: `f${i}.jpg` })));
    check("6 images -> 400 TOO_MANY_FILES", six.status === 400 && six.body.code === "TOO_MANY_FILES", six.body);
    check("...and nothing was sent to ImgBB", seen.length === 0);
  }

  // ---------------------------------------------------------------- rejections
  section("5. Rejected input (nothing may reach ImgBB)");
  {
    reset();
    const big = await upload(vendor.token, [{ data: padded(JPEG, 5 * MB + 1) }]);
    check("5 MB + 1 byte -> 413 FILE_TOO_LARGE", big.status === 413 && big.body.code === "FILE_TOO_LARGE", big.body);

    const bigAmongOk = await upload(vendor.token, [{ data: JPEG }, { data: padded(PNG, 6 * MB), type: "image/png", filename: "big.png" }]);
    check("one oversized file among valid ones -> 413 for the request", bigAmongOk.status === 413, bigAmongOk.body);

    const gif = await upload(vendor.token, [{ data: GIF, filename: "a.gif", type: "image/gif" }]);
    check("GIF -> 415 UNSUPPORTED_FILE_TYPE", gif.status === 415 && gif.body.code === "UNSUPPORTED_FILE_TYPE", gif.body);

    const txt = await upload(vendor.token, [{ data: Buffer.from("hello, not an image"), filename: "a.txt", type: "text/plain" }]);
    check("text file -> 415", txt.status === 415 && txt.body.code === "UNSUPPORTED_FILE_TYPE", txt.body);

    const pdf = await upload(vendor.token, [{ data: Buffer.from("%PDF-1.4 fake"), filename: "a.pdf", type: "application/pdf" }]);
    check("PDF -> 415", pdf.status === 415, pdf.body);

    const fakeJpg = await upload(vendor.token, [{ data: Buffer.from("MZ\x90\x00 pretend exe"), filename: "evil.jpg", type: "image/jpeg" }]);
    check("non-image bytes named .jpg with image/jpeg -> 415 (signature checked)", fakeJpg.status === 415, fakeJpg.body);

    const fakePng = await upload(vendor.token, [{ data: Buffer.from("<svg onload=alert(1)></svg>"), filename: "x.png", type: "image/png" }]);
    check("SVG/script content declared as PNG -> 415", fakePng.status === 415, fakePng.body);

    const mismatch = await upload(vendor.token, [{ data: PNG, filename: "a.jpg", type: "image/jpeg" }]);
    check("PNG content declared as JPEG -> 415", mismatch.status === 415 && /does not match/.test(mismatch.body.message), mismatch.body);

    const wrongMime = await upload(vendor.token, [{ data: JPEG, filename: "a.jpg", type: "application/octet-stream" }]);
    check("JPEG content with an octet-stream type -> 415", wrongMime.status === 415, wrongMime.body);

    const empty = await upload(vendor.token, [{ data: Buffer.alloc(0), filename: "empty.jpg", type: "image/jpeg" }]);
    check("empty file -> 400 EMPTY_FILE", empty.status === 400 && empty.body.code === "EMPTY_FILE", empty.body);

    const nothing = await fetch(`${baseUrl}/api/vendor/upload-image`, {
      method: "POST",
      headers: { authorization: `Bearer ${vendor.token}` },
      body: new FormData(),
    });
    const nothingBody = (await nothing.json()) as Json;
    check("multipart without any file -> 400 NO_FILES", nothing.status === 400 && nothingBody.code === "NO_FILES", nothingBody);

    const asJson = await jsonCall("POST", "/api/vendor/upload-image", vendor.token, { images: ["https://example.com/a.jpg"] });
    check("a JSON body (not multipart) -> 400 NO_FILES", asJson.status === 400 && asJson.body.code === "NO_FILES", asJson.body);

    const wrongField = await upload(vendor.token, [{ data: JPEG, name: "photo" }]);
    check("wrong field name -> 400 UNEXPECTED_FIELD", wrongField.status === 400 && wrongField.body.code === "UNEXPECTED_FIELD", wrongField.body);

    const mixed = await upload(vendor.token, [
      { data: JPEG, filename: "good.jpg" },
      { data: GIF, filename: "bad.gif", type: "image/gif" },
      { data: Buffer.alloc(0), filename: "zero.png", type: "image/png" },
    ]);
    check("good + bad + empty -> request rejected", mixed.status === 415, mixed.body);
    check(
      "...errors list exactly the bad files by position",
      Array.isArray(mixed.body.errors) &&
        mixed.body.errors.length === 2 &&
        mixed.body.errors[0].field === "images[1]" &&
        mixed.body.errors[1].field === "images[2]",
      mixed.body.errors
    );

    const nasty = await upload(vendor.token, [{ data: GIF, filename: "../../etc/pass\nwd.gif", type: "image/gif" }]);
    check(
      "a path / newline in the file name never appears in the message",
      nasty.status === 415 && !/\.\.|etc|\\n/.test(JSON.stringify(nasty.body)) && /passwd\.gif/.test(nasty.body.message),
      nasty.body
    );

    loggedErrors.length = 0;
    const malformed = await upload(vendor.token, [{ data: GIF, filename: "a\u0000b.gif", type: "image/gif" }]);
    check(
      "malformed multipart (NUL byte in a header) -> 400 INVALID_UPLOAD, not 500",
      malformed.status === 400 && malformed.body.code === "INVALID_UPLOAD",
      malformed.body
    );

    // A body that is cut off in the middle.
    const truncated = await realFetch(`${baseUrl}/api/vendor/upload-image`, {
      method: "POST",
      headers: { authorization: `Bearer ${vendor.token}`, "content-type": "multipart/form-data; boundary=XYZ" },
      body: '--XYZ\r\nContent-Disposition: form-data; name="images"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nabc',
    });
    const truncatedBody = (await truncated.json()) as Json;
    check("truncated multipart body -> 400, not 500", truncated.status === 400 && truncatedBody.code === "INVALID_UPLOAD", truncatedBody);
    check("malformed uploads do not log server errors", !loggedErrors.some((l) => l.startsWith("Server Error")), loggedErrors);

    check("ImgBB was never called for any rejected input", seen.length === 0, seen);
  }

  // ---------------------------------------------------- provider failure handling
  section("6. ImgBB failures");
  {
    // invalid key, simulated
    reset();
    stubBehavior = () =>
      Response.json({ status_code: 400, error: { message: "Invalid API v1 key.", code: 100 }, status_txt: "Bad Request" }, { status: 400 });
    const badKey = await upload(vendor.token, [{ data: JPEG }]);
    check("invalid key (simulated) -> 502 UPLOAD_SERVICE_CONFIG_ERROR", badKey.status === 502 && badKey.body.code === "UPLOAD_SERVICE_CONFIG_ERROR", badKey.body);
    check("...key not in response or logs", !JSON.stringify(badKey.body).includes(STUB_KEY) && !loggedErrors.join("\n").includes(STUB_KEY));
    check("...error is logged server-side", loggedErrors.some((l) => l.includes("UPLOAD_SERVICE_CONFIG_ERROR")));

    // other ImgBB refusal
    reset();
    stubBehavior = () => Response.json({ status_code: 400, error: { message: "Empty upload source.", code: 130 } }, { status: 400 });
    const refused = await upload(vendor.token, [{ data: JPEG }]);
    check("other ImgBB refusal -> 502 UPLOAD_SERVICE_ERROR", refused.status === 502 && refused.body.code === "UPLOAD_SERVICE_ERROR", refused.body);
    check("...provider message is not leaked", !JSON.stringify(refused.body).includes("Empty upload source"));

    // rate limit
    reset();
    stubBehavior = () => new Response("slow down", { status: 429 });
    const limited = await upload(vendor.token, [{ data: JPEG }]);
    check("ImgBB 429 -> 503 UPLOAD_SERVICE_BUSY", limited.status === 503 && limited.body.code === "UPLOAD_SERVICE_BUSY", limited.body);

    // ImgBB down / HTML error page
    reset();
    stubBehavior = () => new Response("<html>Bad gateway</html>", { status: 502 });
    const html = await upload(vendor.token, [{ data: JPEG }]);
    check("ImgBB returns an HTML error page -> 502 UPLOAD_SERVICE_ERROR", html.status === 502 && html.body.code === "UPLOAD_SERVICE_ERROR", html.body);

    // 200 but garbage
    reset();
    stubBehavior = () => Response.json({ success: true, status: 200, data: {} });
    const garbage = await upload(vendor.token, [{ data: JPEG }]);
    check("success without a url -> 502 UPLOAD_SERVICE_ERROR", garbage.status === 502 && garbage.body.code === "UPLOAD_SERVICE_ERROR", garbage.body);

    reset();
    stubBehavior = () => Response.json({ success: true, status: 200, data: { url: "javascript:alert(1)" } });
    const js = await upload(vendor.token, [{ data: JPEG }]);
    check("a non-https url from the provider is refused", js.status === 502, js.body);

    // network error
    reset();
    stubBehavior = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const net = await upload(vendor.token, [{ data: JPEG }]);
    check("network error -> 502 UPLOAD_SERVICE_UNAVAILABLE", net.status === 502 && net.body.code === "UPLOAD_SERVICE_UNAVAILABLE", net.body);
    check("...no stack trace / internals in the response", !/ECONNREFUSED|fetch failed|stack/i.test(JSON.stringify(net.body)), net.body);

    // timeout
    reset();
    stubBehavior = () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const slow = await upload(vendor.token, [{ data: JPEG }]);
    check("timeout -> 504 UPLOAD_TIMEOUT", slow.status === 504 && slow.body.code === "UPLOAD_TIMEOUT", slow.body);

    // the request gets an AbortSignal with a timeout
    reset();
    let signalSeen = false;
    const wrapped = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.imgbb.com/")) signalSeen = init?.signal instanceof AbortSignal;
      return wrapped(input, init);
    }) as typeof fetch;
    await upload(vendor.token, [{ data: JPEG }]);
    globalThis.fetch = wrapped;
    check("every ImgBB request carries an AbortSignal (timeout)", signalSeen);

    // partial failure: the 2nd of 3 images fails (identified by its size)
    reset();
    const failSize = JPEG.length + 7;
    stubBehavior = (call) =>
      call.size === failSize
        ? Response.json({ status_code: 500, error: { message: "boom", code: 500 } }, { status: 500 })
        : okResponse(call);
    const partial = await upload(vendor.token, [
      { data: JPEG, filename: "ok1.jpg" },
      { data: padded(JPEG, failSize), filename: "fails.jpg" },
      { data: PNG, filename: "ok2.png", type: "image/png" },
    ]);
    check("partial failure -> request fails (502 UPLOAD_SERVICE_ERROR)", partial.status === 502 && partial.body.success === false && partial.body.code === "UPLOAD_SERVICE_ERROR", partial.body);
    check("...errors name the failed file by position", partial.body.errors?.length === 1 && partial.body.errors[0].field === "images[1]", partial.body.errors);
    check(
      "...data.images holds the 2 that DID upload, with their index",
      partial.body.data?.images?.length === 2 &&
        partial.body.data.images[0].index === 0 &&
        partial.body.data.images[1].index === 2 &&
        partial.body.data.images.every((i: { url: string }) => i.url.startsWith("https://")),
      partial.body.data
    );
    check("...message says how many failed", /1 of 3 images could not be uploaded/.test(partial.body.message), partial.body.message);
  }

  // -------------------------------------------------- real ImgBB, invalid key
  section("7. REAL ImgBB with an invalid key (case 12, needs internet)");
  {
    provider = "real";
    (env as { IMGBB_API_KEY?: string }).IMGBB_API_KEY = "invalid-key-for-test-only";
    reset();

    try {
      const res = await upload(vendor.token, [{ data: PNG, type: "image/png", filename: "p.png" }]);

      if (res.status === 502 && res.body.code === "UPLOAD_SERVICE_UNAVAILABLE") {
        console.log("  skip  ImgBB not reachable from here (no internet?)");
      } else {
        check("real ImgBB rejects the junk key -> 502 UPLOAD_SERVICE_CONFIG_ERROR", res.status === 502 && res.body.code === "UPLOAD_SERVICE_CONFIG_ERROR", res.body);
        check("...junk key is not in the response", !JSON.stringify(res.body).includes("invalid-key-for-test-only"));
        check("...junk key is not in the logs", !loggedErrors.join("\n").includes("invalid-key-for-test-only"), loggedErrors);
        check("...ImgBB's own message is logged server-side", loggedErrors.some((l) => /Invalid API v1 key/i.test(l)), loggedErrors);
      }
    } finally {
      provider = "stub";
      (env as { IMGBB_API_KEY?: string }).IMGBB_API_KEY = STUB_KEY;
    }
  }

  // --------------------------------------------------- vendor menu integration
  section("8. Uploaded URLs work in a vendor menu item (case 14)");
  {
    reset();
    const up = await upload(vendor.token, [
      { data: JPEG, filename: "a.jpg" },
      { data: PNG, filename: "b.png", type: "image/png" },
    ]);
    const urls: string[] = up.body.data.images.map((i: { url: string }) => i.url);

    const created = await jsonCall("POST", "/api/vendor/menu-items", vendor.token, {
      itemName: "Pizza with photos",
      category: "Pizza",
      description: "Created with uploaded images",
      price: 450,
      location: "Dhaka",
      images: urls,
    });
    check("POST /api/vendor/menu-items with the uploaded URLs -> 201 pending", created.status === 201 && created.body.data.status === "pending", created.body);
    check("...images saved exactly as uploaded", JSON.stringify(created.body.data.images) === JSON.stringify(urls), created.body.data?.images);

    const stored = await menuItemsCollection().findOne({ _id: new ObjectId(created.body.data._id) });
    check("...stored in the database as plain URL strings", JSON.stringify(stored?.images) === JSON.stringify(urls), stored?.images);
    check("...no key / secret stored in the item", !JSON.stringify(stored).includes(STUB_KEY) && !JSON.stringify(stored).includes("SECRETDELETETOKEN"));

    const stillValidated = await jsonCall("POST", "/api/vendor/menu-items", vendor.token, {
      itemName: "Bad image",
      category: "Pizza",
      description: "x",
      price: 1,
      location: "Dhaka",
      images: ["javascript:alert(1)"],
    });
    check("menu API still rejects a non-URL image (unchanged)", stillValidated.status === 400, stillValidated.body);
  }

  // ---------------------------------------------------------------- other routes
  section("9. Other routes unaffected");
  {
    const health = await realFetch(`${baseUrl}/api/health`);
    check("GET /api/health -> 200", health.status === 200);
    const menu = await realFetch(`${baseUrl}/api/menu-items`);
    check("GET /api/menu-items -> 200", menu.status === 200);
    const get = await realFetch(`${baseUrl}/api/vendor/upload-image`, { headers: { authorization: `Bearer ${vendor.token}` } });
    check("GET on the upload route is not an upload endpoint -> 404", get.status === 404);
  }
} catch (error) {
  console.error = originalConsoleError;
  failures.push("script crashed");
  console.error("\nScript crashed:", error);
} finally {
  console.error = originalConsoleError;
  globalThis.fetch = realFetch;
  server.close();

  const dbName = getDB().databaseName;

  try {
    await getDB().dropDatabase();
    console.log(`\n(dropped throwaway database ${dbName})`);
  } catch (error) {
    console.error("Could not drop the throwaway database:", error);
  }

  await client.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);

if (failures.length > 0) {
  console.log("Failed:");
  for (const name of failures) console.log(` - ${name}`);
  process.exit(1);
}
process.exit(0);
