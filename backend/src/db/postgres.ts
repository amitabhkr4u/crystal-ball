import type { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | undefined;

// Returns the shared Prisma client for PostgreSQL.
export function getPrisma(): PrismaClient {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for PostgreSQL operations");
  if (!prisma) {
    // Loaded lazily so processes that never touch PostgreSQL do not pay for the client.
    const { PrismaClient: Client } = require("@prisma/client") as typeof import("@prisma/client");
    prisma = new Client({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
    });
  }
  return prisma;
}

// Disconnects Prisma and clears the shared client.
export async function disconnectPostgres(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }
}
