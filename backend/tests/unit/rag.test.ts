import { chunkText } from "../../src/rag/maintenanceIngest.service";
import { validateEmbedding } from "../../src/rag/maintenanceSearch.service";

describe("maintenance RAG pipeline", () => {
  it("chunks document text with bounded overlap", () => {
    const text = "A".repeat(2600);
    const chunks = chunkText(text, { maxChars: 1000, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
    const [first, second] = chunks;
    expect(first?.slice(-100)).toBe(second?.slice(0, 100));
  });

  it("prefers to break chunks on a line boundary", () => {
    const text = `${"A".repeat(700)}\n${"B".repeat(700)}`;
    const [first, second] = chunkText(text, { maxChars: 1000, overlap: 0 });
    expect(first).toBe("A".repeat(700));
    expect(second?.startsWith("B")).toBe(true);
  });

  it("rejects empty text and invalid chunk settings", () => {
    expect(() => chunkText("   ")).toThrow("Document text is required");
    expect(() => chunkText("text", { maxChars: 100 })).toThrow("Invalid chunk settings");
    expect(() => chunkText("text", { maxChars: 1000, overlap: 1000 })).toThrow("Invalid chunk settings");
  });

  it("rejects malformed embedding dimensions", () => {
    expect(() => validateEmbedding([0.1, 0.2])).toThrow(/1536/);
  });

  it("accepts a valid vector and rejects non-finite or non-numeric entries", () => {
    expect(() => validateEmbedding(new Array<number>(1536).fill(0.1))).not.toThrow();
    const withNaN = new Array<number>(1536).fill(0.1);
    withNaN[10] = Number.NaN;
    expect(() => validateEmbedding(withNaN)).toThrow(/1536/);
    expect(() => validateEmbedding(new Array<string>(1536).fill("x"))).toThrow(/1536/);
    expect(() => validateEmbedding("not an array")).toThrow(/1536/);
  });
});
