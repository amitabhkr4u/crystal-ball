import { randomUUID } from "node:crypto";
import type { PrismaClient, Tenant, User } from "@prisma/client";
import { disconnectPostgres, getPrisma } from "../../src/db/postgres";
import { withTenantTransaction } from "../../src/db/tenantTransaction";

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === "true" ? describe : describe.skip;

describePostgres("PostgreSQL tenant row-level security", () => {
  let prisma!: PrismaClient;
  const suffix = randomUUID();
  let tenantA!: Tenant;
  let tenantB!: Tenant;
  let userA!: User;
  let userB!: User;

  beforeAll(async () => {
    prisma = getPrisma();
    await prisma.$connect();
    tenantA = await prisma.tenant.create({ data: { name: `Tenant A ${suffix}`, slug: `tenant-a-${suffix}` } });
    tenantB = await prisma.tenant.create({ data: { name: `Tenant B ${suffix}`, slug: `tenant-b-${suffix}` } });
    userA = await prisma.user.create({
      data: { email: `a-${suffix}@example.test`, passwordHash: "test-hash", fullName: "Tenant A User" }
    });
    userB = await prisma.user.create({
      data: { email: `b-${suffix}@example.test`, passwordHash: "test-hash", fullName: "Tenant B User" }
    });
    await withTenantTransaction(tenantA.id, (tx) =>
      tx.membership.create({ data: { tenantId: tenantA.id, userId: userA.id, role: "operator" } })
    );
    await withTenantTransaction(tenantB.id, (tx) =>
      tx.membership.create({ data: { tenantId: tenantB.id, userId: userB.id, role: "operator" } })
    );
  });

  afterAll(async () => {
    if (tenantA) {
      await withTenantTransaction(tenantA.id, (tx) => tx.membership.deleteMany());
      await prisma.tenant.delete({ where: { id: tenantA.id } });
    }
    if (tenantB) {
      await withTenantTransaction(tenantB.id, (tx) => tx.membership.deleteMany());
      await prisma.tenant.delete({ where: { id: tenantB.id } });
    }
    if (userA) await prisma.user.delete({ where: { id: userA.id } });
    if (userB) await prisma.user.delete({ where: { id: userB.id } });
    await disconnectPostgres();
  });

  it("returns only memberships belonging to the active tenant", async () => {
    const memberships = await withTenantTransaction(tenantA.id, (tx) => tx.membership.findMany());
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.tenantId).toBe(tenantA.id);
    expect(memberships[0]?.userId).toBe(userA.id);
  });

  it("rejects a tenant id that is not a UUID before touching the database", async () => {
    await expect(withTenantTransaction("not-a-uuid", async () => 1)).rejects.toThrow("valid tenant UUID");
  });
});
