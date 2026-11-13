import mongoose from "mongoose";
import { env } from "../config/env";

export type MongoConnectResult = { connected: true } | { connected: false; reason: string };

// Connects Mongoose to MongoDB when a URI is set.
export async function connectMongo(): Promise<MongoConnectResult> {
  if (!env.MONGODB_URI) return { connected: false, reason: "MONGODB_URI not configured" };
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 20 });
  return { connected: true };
}

export { mongoose };
