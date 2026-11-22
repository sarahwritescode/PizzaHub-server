/**
 * Checks the allowed-origins setup (CLIENT_URL + EXTRA_ALLOWED_ORIGINS): `npm run verify:origins`.
 *
 * The allowed list is read once at start-up, so each scenario runs in its own
 * child process with its own environment:
 *   A) EXTRA_ALLOWED_ORIGINS unset  -> only the production frontend works
 *   B) EXTRA_ALLOWED_ORIGINS=http://localhost:3000 -> both work, others still do not
 *   C) invalid EXTRA_ALLOWED_ORIGINS values -> the server refuses to start
 * Scenarios A and B use a throwaway database (dropped at the end).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROD = "https://pizza-hub-client-pearl.vercel.app";
const LOCAL = "http://localhost:3000";
const EVIL = "https://evil.example";
const self = fileURLToPath(import.meta.url);

type Mode = "unset" | "set" | "print";
const mode = process.env.ORIGINS_CHILD as Mode | undefined;

// ===================================================================== child
if (mode === "print") {
  const { ALLOWED_ORIGINS } = await import("../config/env.js");
  console.log(`ALLOWED=${JSON.stringify(ALLOWED_ORIGINS)}`);
  process.exit(0);
}

if (mode === "unset" || mode === "set") {
  process.env.DB_NAME = `pizzahub_origins_verify_${Date.now()}`;

  const { default: app } = await import("../app.js");
  const { client, connectDB, getDB } = await import("../config/db.js");
  const { initializeDatabase } = await import("../config/initDatabase.js");

  let passed = 0;
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (ok) {
      passed++;
      console.log(`  ok   ${name}`);
    } else {
      failures.push(name);
      console.log(`  FAIL ${name}${detail === undefined ? "" : `\n       got: ${JSON.stringify(detail)}`}`);
    }
  };

  const server = app.listen(0);
  const extraSet = mode === "set";

  try {
    await connectDB();
    await initializeDatabase();
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const send = async (method: string, path: string, origin: string | null, opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
      const headers: Record<string, string> = { ...opts.headers };
      if (origin) headers.origin = origin;
      if (opts.cookie) headers.cookie = opts.cookie;
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
      const text = await response.text();
      let body: { code?: string; message?: string } = {};
      try {
        body = JSON.parse(text);
      } catch {
        // preflight has no body
      }
      return { status: response.status, body, acao: response.headers.get("access-control-allow-origin"), acac: response.headers.get("access-control-allow-credentials") };
    };

    // A real vendor with a real session cookie (signed up from the primary origin).
    const email = `origins.${Date.now()}@pizzahub.test`;
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: PROD },
      body: JSON.stringify({ name: "origins", email, password: "Passw0rdOK", role: "vendor" }),
    });
    const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    check("setup: sign-up from CLIENT_URL works", signUp.ok && cookie.length > 0, signUp.status);

    const wrong = { email, password: "WrongPassw0rd" };
    const signIn = "/api/auth/sign-in/email";

    console.log(`\nBetter Auth sign-in with a wrong password (EXTRA_ALLOWED_ORIGINS ${extraSet ? "= " + LOCAL : "unset"})`);
    const fromProd = await send("POST", signIn, PROD, { body: wrong });
    check(`Origin = CLIENT_URL -> 401 INVALID_EMAIL_OR_PASSWORD (not 403)`, fromProd.status === 401 && fromProd.body.code === "INVALID_EMAIL_OR_PASSWORD", fromProd);

    const fromLocal = await send("POST", signIn, LOCAL, { body: wrong });
    if (extraSet) {
      check(`Origin = ${LOCAL} -> 401 INVALID_EMAIL_OR_PASSWORD (not 403 INVALID_ORIGIN)`, fromLocal.status === 401 && fromLocal.body.code === "INVALID_EMAIL_OR_PASSWORD", fromLocal);
    } else {
      check(`Origin = ${LOCAL} -> 403 INVALID_ORIGIN`, fromLocal.status === 403 && fromLocal.body.code === "INVALID_ORIGIN", fromLocal);
    }

    const fromEvil = await send("POST", signIn, EVIL, { body: wrong });
    check(`Origin = ${EVIL} -> 403 INVALID_ORIGIN`, fromEvil.status === 403 && fromEvil.body.code === "INVALID_ORIGIN", fromEvil);

    const fromEvilWithCookie = await send("POST", signIn, EVIL, { body: wrong, cookie });
    check(`Origin = ${EVIL} with a session cookie -> 403 INVALID_ORIGIN`, fromEvilWithCookie.status === 403 && fromEvilWithCookie.body.code === "INVALID_ORIGIN", fromEvilWithCookie);

    console.log("\nCORS preflight (OPTIONS) and normal responses");
    const preflight = (origin: string) =>
      send("OPTIONS", signIn, origin, { headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" } });

    const pfProd = await preflight(PROD);
    check("preflight from CLIENT_URL -> Access-Control-Allow-Origin = CLIENT_URL, credentials true", pfProd.acao === PROD && pfProd.acac === "true", pfProd);
    const pfLocal = await preflight(LOCAL);
    check(
      extraSet ? `preflight from ${LOCAL} -> Access-Control-Allow-Origin = ${LOCAL}, credentials true` : `preflight from ${LOCAL} -> no Access-Control-Allow-Origin`,
      extraSet ? pfLocal.acao === LOCAL && pfLocal.acac === "true" : pfLocal.acao === null,
      pfLocal
    );
    const pfEvil = await preflight(EVIL);
    check(`preflight from ${EVIL} -> no Access-Control-Allow-Origin`, pfEvil.acao === null, pfEvil);

    const getLocal = await send("GET", "/api/health", LOCAL);
    check(
      extraSet ? `GET /api/health from ${LOCAL} echoes ${LOCAL}` : `GET /api/health from ${LOCAL} has no CORS header`,
      extraSet ? getLocal.acao === LOCAL : getLocal.acao === null,
      getLocal
    );
    const getEvil = await send("GET", "/api/health", EVIL);
    check(`GET /api/health from ${EVIL} has no CORS header`, getEvil.acao === null && getEvil.status === 200, getEvil);
    const noOrigin = await send("GET", "/api/health", null);
    check("no Origin header (curl, Postman, server-to-server) -> 200, no CORS header", noOrigin.status === 200 && noOrigin.acao === null, noOrigin);
    check("the allowed origin is never '*'", ![pfProd, pfLocal, pfEvil, getLocal, getEvil].some((r) => r.acao === "*"));

    console.log("\nCookie-authenticated write (the CSRF origin check in middleware/auth.ts)");
    const write = (origin: string | null) => send("POST", "/api/vendor/menu-items", origin, { cookie, body: {} });

    const wProd = await write(PROD);
    check("CLIENT_URL origin passes the origin check (then 400 validation, empty body)", wProd.status === 400 && wProd.body.code === "VALIDATION_ERROR", wProd);
    const wLocal = await write(LOCAL);
    if (extraSet) {
      check(`${LOCAL} passes the origin check (400 validation)`, wLocal.status === 400 && wLocal.body.code === "VALIDATION_ERROR", wLocal);
    } else {
      check(`${LOCAL} -> 403 ORIGIN_NOT_ALLOWED`, wLocal.status === 403 && wLocal.body.code === "ORIGIN_NOT_ALLOWED", wLocal);
    }
    const wEvil = await write(EVIL);
    check(`${EVIL} -> 403 ORIGIN_NOT_ALLOWED`, wEvil.status === 403 && wEvil.body.code === "ORIGIN_NOT_ALLOWED", wEvil);
    const wLookalike = await write(`${PROD}.evil.example`);
    check("a look-alike origin (CLIENT_URL + '.evil.example') -> 403 ORIGIN_NOT_ALLOWED", wLookalike.status === 403 && wLookalike.body.code === "ORIGIN_NOT_ALLOWED", wLookalike);
    const wHttp = await write("http://pizza-hub-client-pearl.vercel.app");
    check("same host over http (different origin) -> 403 ORIGIN_NOT_ALLOWED", wHttp.status === 403 && wHttp.body.code === "ORIGIN_NOT_ALLOWED", wHttp);
    const wNull = await write("null");
    check("Origin: null -> 403 ORIGIN_NOT_ALLOWED", wNull.status === 403 && wNull.body.code === "ORIGIN_NOT_ALLOWED", wNull);
    const wNone = await write(null);
    check("no Origin header (non-browser client) is not an origin-check failure", wNone.status === 400, wNone);
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
  process.exit(failures.length > 0 ? 1 : 0);
}

// ==================================================================== parent
const run = (child: Mode, extra: string | undefined) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ORIGINS_CHILD: child, CLIENT_URL: PROD };
  if (extra === undefined) delete env.EXTRA_ALLOWED_ORIGINS;
  else env.EXTRA_ALLOWED_ORIGINS = extra;

  const result = spawnSync(process.execPath, ["--import", "tsx", self], { env, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
};

let failed = false;

for (const [label, child, extra] of [
  ["A) EXTRA_ALLOWED_ORIGINS unset", "unset", undefined],
  [`B) EXTRA_ALLOWED_ORIGINS=${LOCAL}`, "set", LOCAL],
] as const) {
  console.log(`\n========== ${label}  (CLIENT_URL=${PROD}) ==========`);
  const { code, out } = run(child, extra);
  console.log(out.split("\n").filter((line) => !/^MongoDB connected/.test(line)).join("\n").trimEnd());
  if (code !== 0) failed = true;
}

console.log("\n========== C) parsing EXTRA_ALLOWED_ORIGINS ==========");
let passedC = 0;
const failC: string[] = [];

const expectList = (value: string | undefined, expected: string[], name: string) => {
  const { code, out } = run("print", value);
  const got = /ALLOWED=(.*)/.exec(out)?.[1];
  const ok = code === 0 && got === JSON.stringify(expected);
  ok ? passedC++ : failC.push(name);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got: ${got ?? out.trim().slice(0, 200)}`}`);
};

const expectRefused = (value: string, name: string) => {
  const { code, out } = run("print", value);
  const ok = code !== 0 && /Invalid environment variables/.test(out) && !/ALLOWED=/.test(out);
  ok ? passedC++ : failC.push(name);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got: code ${code} ${out.trim().slice(0, 200)}`}`);
};

expectList(undefined, [PROD], "unset -> only CLIENT_URL");
expectList("", [PROD], "empty -> only CLIENT_URL");
expectList(" , ,", [PROD], "only commas/spaces -> only CLIENT_URL");
expectList(LOCAL, [PROD, LOCAL], "one extra origin");
expectList(`${LOCAL}/, http://127.0.0.1:3000/some/path?x=1`, [PROD, LOCAL, "http://127.0.0.1:3000"], "trailing slash and path are dropped (normalised with .origin)");
expectList(`${PROD}/, ${LOCAL}, ${LOCAL}`, [PROD, LOCAL], "duplicates (also of CLIENT_URL) appear once");
expectRefused("*", '"*" is refused');
expectRefused("https://*.vercel.app", "wildcard host is refused");
expectRefused("localhost:3000", "no protocol is refused");
expectRefused("ftp://example.com", "non-http(s) protocol is refused");
expectRefused("javascript:alert(1)", "javascript: is refused");
expectRefused(`${LOCAL},*`, "one bad entry among good ones refuses the whole value");

console.log(`\n${passedC} passed, ${failC.length} failed (scenario C)`);
if (failC.length > 0) failed = true;

console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL ORIGIN CHECKS PASSED");
process.exit(failed ? 1 : 0);
