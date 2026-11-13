-- Run as a database owner during deployment; requires PostgreSQL pgvector extension.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS "MaintenanceChunk" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" uuid NOT NULL,
  "documentId" text NOT NULL,
  content text NOT NULL,
  embedding vector(1536) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maintenance_chunk_tenant_idx ON "MaintenanceChunk" ("tenantId");
CREATE INDEX IF NOT EXISTS maintenance_chunk_embedding_idx ON "MaintenanceChunk" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
ALTER TABLE "MaintenanceChunk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MaintenanceChunk" FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'maintenance_chunk_tenant_isolation') THEN
    CREATE POLICY maintenance_chunk_tenant_isolation ON "MaintenanceChunk"
      USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);
  END IF;
END $$;
