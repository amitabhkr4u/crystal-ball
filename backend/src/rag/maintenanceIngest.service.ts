import { withTenantTransaction } from "../db/tenantTransaction";
import { createEmbeddings } from "../services/embedding.service";

const EMBEDDING_BATCH_SIZE = 64;
const MAX_CHUNKS = 200;

export interface ChunkOptions {
  maxChars?: number;
  overlap?: number;
}

// Splits document text into overlapping chunks.
export function chunkText(text: string, { maxChars = 1200, overlap = 150 }: ChunkOptions = {}): string[] {
  if (typeof text !== "string" || !text.trim()) throw new TypeError("Document text is required");
  if (maxChars < 200 || overlap < 0 || overlap >= maxChars) throw new RangeError("Invalid chunk settings");
  const chunks: string[] = [];
  let cursor = 0;
  const clean = text.replace(/\r\n/g, "\n").trim();
  while (cursor < clean.length) {
    let end = Math.min(cursor + maxChars, clean.length);
    if (end < clean.length) {
      const boundary = clean.lastIndexOf("\n", end);
      if (boundary > cursor + Math.floor(maxChars * 0.6)) end = boundary;
    }
    const chunk = clean.slice(cursor, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= clean.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return chunks;
}

export interface IngestInput {
  tenantId: string;
  documentId: string;
  text: string;
  metadata?: Record<string, unknown>;
}

// Embeds a document and stores its chunks in pgvector.
export async function ingestMaintenanceDocument(
  input: IngestInput
): Promise<{ documentId: string; chunksIndexed: number }> {
  const { tenantId, documentId, text, metadata = {} } = input;
  if (!tenantId || !documentId || documentId.length > 180) throw new TypeError("tenantId and documentId are required");
  const chunks = chunkText(text);
  if (chunks.length > MAX_CHUNKS) throw new RangeError("Document is too large to index in one request");
  const vectors: number[][] = [];
  for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = await createEmbeddings(chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE), tenantId);
    if (!batch) throw new Error("EMBEDDINGS_API_KEY is not configured");
    vectors.push(...batch);
  }
  await withTenantTransaction(tenantId, async (tx) => {
    await tx.$executeRaw`DELETE FROM "MaintenanceChunk" WHERE "tenantId" = ${tenantId}::uuid AND "documentId" = ${documentId}`;
    for (const [index, content] of chunks.entries()) {
      const values = vectors[index];
      if (!values) throw new Error("Embedding provider returned fewer vectors than chunks");
      const vector = `[${values.join(",")}]`;
      await tx.$executeRaw`INSERT INTO "MaintenanceChunk" ("tenantId", "documentId", content, embedding, metadata) VALUES (${tenantId}::uuid, ${documentId}, ${content}, ${vector}::vector, ${JSON.stringify({ ...metadata, chunkIndex: index })}::jsonb)`;
    }
  });
  return { documentId, chunksIndexed: chunks.length };
}
