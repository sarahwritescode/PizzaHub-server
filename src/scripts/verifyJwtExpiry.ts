/**
 * Checks that an EXPIRED access JWT is refused: `npm run verify:jwt-expiry`.
 *
 * JWT_EXPIRES_IN is set to 2 seconds BEFORE the app is loaded, a real user signs up (throwaway
 * database, dropped at the end), gets a real Better Auth token, and the script waits until it has
 * run out. The other verify scripts keep the normal 15 minute lifetime.
 */
process.env.DB_NAME = `pizzahub_jwt_verify_${Date.now()}`;
process.env.JWT_EXPIRES_IN = "2s";

const { default: app } = await import("../app.js");
const { env } = await import("../config/env.js");
const { client, connectDB, getDB } = await import("../config/db.js");
const { initializeDatabase } = await import("../config/initDatabase.js");

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

const server = app.listen(0);

try {
  await connectDB();
  await initializeDatabase();
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  check("JWT_EXPIRES_IN is 2s for this run", env.JWT_EXPIRES_IN === "2s", env.JWT_EXPIRES_IN);

  const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.CLIENT_URL },
    body: JSON.stringify({ name: "Expiry", email: `expiry.${Date.now()}@pizzahub.test`, password: "Passw0rdOK", role: "customer" }),
  });
  const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const { token } = (await (await fetch(`${baseUrl}/api/auth/token`, { headers: { cookie } })).json()) as { token: string };

  const protectedCall = async (jwt: string) => {
    const res = await fetch(`${baseUrl}/api/test/protected`, { headers: { authorization: `Bearer ${jwt}` } });
    return { status: res.status, body: (await res.json()) as { code?: string } };
  };

  const fresh = await protectedCall(token);
  check("a fresh token works -> 200", fresh.status === 200, fresh);

  await new Promise((resolve) => setTimeout(resolve, 3500));

  const expired = await protectedCall(token);
  check("the same token after it expired -> 401 TOKEN_EXPIRED", expired.status === 401 && expired.body.code === "TOKEN_EXPIRED", expired);

  const cookieCall = await fetch(`${baseUrl}/api/test/protected`, { headers: { cookie } });
  check("the session cookie still works (the JWT is separate from the session) -> 200", cookieCall.status === 200, cookieCall.status);

  const { token: newToken } = (await (await fetch(`${baseUrl}/api/auth/token`, { headers: { cookie } })).json()) as { token: string };
  check("a new token can be requested and works -> 200", (await protectedCall(newToken)).status === 200);
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
