/**
 * Creates (or promotes) the admin account. Run with:  npm run seed:admin
 *
 * Reads ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD from .env.
 * The role is written straight to MongoDB: the public API can never set "admin".
 */
import { client, connectDB } from "../config/db.js";
import { auth } from "../lib/auth.js";

const name = process.env.ADMIN_NAME?.trim() || "Admin";
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;

const run = async () => {
  if (!email || !password) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
  }

  const db = await connectDB();
  const users = db.collection("users");

  const existing = await users.findOne({ email });

  if (!existing) {
    // Goes through better-auth so the password is hashed the normal way
    // and the account row is created in the same shape as any other user.
    await auth.api.signUpEmail({ body: { name, email, password } });
    console.log(`Created user ${email}`);
  } else {
    console.log(`User ${email} already exists, promoting it`);
  }

  const result = await users.updateOne(
    { email },
    { $set: { role: "admin", isBlocked: false, updatedAt: new Date() } }
  );

  if (result.matchedCount !== 1) {
    throw new Error(`Could not find ${email} to promote`);
  }

  console.log(`${email} is now an admin`);
};

run()
  .catch((error) => {
    console.error("Seeding admin failed:", error);
    process.exitCode = 1;
  })
  .finally(() => client.close());
