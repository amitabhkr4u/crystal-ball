import { createHash } from "node:crypto";

// Builds a stable sha256 id from the given parts.
export function hashId(...parts: ReadonlyArray<string | number>): string {
  return createHash("sha256").update(parts.join(":")).digest("hex");
}
