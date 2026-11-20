import { app } from "./app.js";
import { connectDB, client } from "./config/db.js";
import { env } from "./config/env.js";

const startServer = async () => {
  try {
    // Connect MongoDB before starting Express
    await connectDB();

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