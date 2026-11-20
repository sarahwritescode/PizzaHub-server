import { MongoClient, ServerApiVersion } from "mongodb";
import { env } from "./env.js";

const client = new MongoClient(env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let isConnected = false;

export const connectDB = async () => {
  if (isConnected) {
    return client.db(env.DB_NAME);
  }

  await client.connect();

  // Verify the database connection
  await client.db("admin").command({ ping: 1 });

  isConnected = true;

  console.log("MongoDB connected successfully");

  return client.db(env.DB_NAME);
};

export const getDB = () => {
  if (!isConnected) {
    throw new Error("Database is not connected yet");
  }

  return client.db(env.DB_NAME);
};

export { client };