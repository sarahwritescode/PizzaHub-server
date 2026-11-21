import app from "./app.js";
import { connectDB, client } from "./config/db.js";
import { initializeDatabase } from "./config/initDatabase.js";
import { env } from "./config/env.js";

const startServer = async () => {
  try {
    // Connect MongoDB before starting Express
    await connectDB();

    // Collections, validators and indexes. Safe on every start (see initDatabase.ts).
    const dbReport = await initializeDatabase();

    if (dbReport.collectionsCreated.length || dbReport.indexesCreated.length) {
      console.log("Database initialised:", {
        collectionsCreated: dbReport.collectionsCreated,
        indexesCreated: dbReport.indexesCreated,
      });
    }

    for (const problem of dbReport.problems) {
      console.error("Database problem:", problem);
    }

    app.listen(env.PORT, () => {
      console.log(`PizzaHub API is running on port ${env.PORT}`);
      console.log(`Environment: ${env.NODE_ENV}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);

    await client.close().catch(() => undefined);

    process.exit(1);
  }
};

startServer();