import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { errorMessage } from "../src/utils/errors";

const prisma = new PrismaClient();

const SEED_PERMISSIONS = ["alerts:classify", "files:upload", "approvals:read", "tenant:manage"] as const;

const seedEnvSchema = z.object({
  SEED_TENANT_NAME: z.string().min(1),
  SEED_TENANT_SLUG: z.string().min(1),
  SEED_ADMIN_EMAIL: z.string().min(1),
  SEED_ADMIN_NAME: z.string().min(1),
  SEED_ADMIN_PASSWORD: z.string().min(12, "SEED_ADMIN_PASSWORD must be at least 12 characters.")
});

// Reads the seed settings from the environment or explains what is missing.
function readSeedEnv(): z.infer<typeof seedEnvSchema> {
  const parsed = seedEnvSchema.safeParse(process.env);
  if (parsed.success) return parsed.data;
  const passwordIssue = parsed.error.issues.find(
    (issue) => issue.path[0] === "SEED_ADMIN_PASSWORD" && issue.code === "too_small"
  );
  if (passwordIssue) throw new Error(passwordIssue.message);
  throw new Error(
    "Set SEED_TENANT_NAME, SEED_TENANT_SLUG, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD and SEED_ADMIN_NAME before seeding."
  );
}

// Creates the demo tenant, admin user and permissions.
async function main(): Promise<void> {
  const seed = readSeedEnv();
  const email = seed.SEED_ADMIN_EMAIL.toLowerCase();

  const tenant = await prisma.tenant.upsert({
    where: { slug: seed.SEED_TENANT_SLUG },
    update: { name: seed.SEED_TENANT_NAME },
    create: { name: seed.SEED_TENANT_NAME, slug: seed.SEED_TENANT_SLUG }
  });
  const passwordHash = await bcrypt.hash(seed.SEED_ADMIN_PASSWORD, 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, fullName: seed.SEED_ADMIN_NAME, isActive: true },
    create: { email, passwordHash, fullName: seed.SEED_ADMIN_NAME }
  });
  await prisma.membership.upsert({
    where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
    update: { role: "admin" },
    create: { tenantId: tenant.id, userId: user.id, role: "admin" }
  });
  const role = await prisma.role.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "admin" } },
    update: {},
    create: { tenantId: tenant.id, name: "admin", description: "Tenant administrator" }
  });
  for (const key of SEED_PERMISSIONS) {
    const permission = await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: `Allows ${key}` }
    });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id }
    });
  }
  console.log(`Seeded tenant ${tenant.slug} and admin user ${user.email}.`);
}

main()
  .catch((error: unknown) => {
    console.error("[seed] failed:", errorMessage(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
