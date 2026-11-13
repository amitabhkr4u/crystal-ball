-- Apply after Prisma migrations. withTenantTransaction sets app.tenant_id transaction-locally.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'Membership' AND policyname = 'membership_tenant_isolation') THEN
    CREATE POLICY membership_tenant_isolation ON "Membership"
      USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Membership" FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'AuditLog' AND policyname = 'auditlog_tenant_isolation') THEN
    CREATE POLICY auditlog_tenant_isolation ON "AuditLog"
      USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'BillingRecord' AND policyname = 'billing_tenant_isolation') THEN
    CREATE POLICY billing_tenant_isolation ON "BillingRecord"
      USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
ALTER TABLE "BillingRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingRecord" FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'Role' AND policyname = 'role_tenant_isolation') THEN
    CREATE POLICY role_tenant_isolation ON "Role"
      USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
ALTER TABLE "Role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Role" FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'RolePermission' AND policyname = 'rolepermission_tenant_isolation') THEN
    CREATE POLICY rolepermission_tenant_isolation ON "RolePermission"
      USING (EXISTS (SELECT 1 FROM "Role" r WHERE r.id = "RolePermission"."roleId" AND r."tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
      WITH CHECK (EXISTS (SELECT 1 FROM "Role" r WHERE r.id = "RolePermission"."roleId" AND r."tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
  END IF;
END $$;
ALTER TABLE "RolePermission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RolePermission" FORCE ROW LEVEL SECURITY;
