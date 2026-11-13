import type { Prisma } from "@prisma/client";
import { getPrisma } from "./postgres";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Runs a callback inside a transaction scoped to one tenant (row-level security).
export async function withTenantTransaction<T>(
  tenantId: string,
  callback: (transaction: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if (!UUID_PATTERN.test(tenantId)) throw new Error("A valid tenant UUID is required");
  return getPrisma().$transaction(
    async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return callback(transaction);
    },
    { timeout: 10000, maxWait: 5000 }
  );
}
