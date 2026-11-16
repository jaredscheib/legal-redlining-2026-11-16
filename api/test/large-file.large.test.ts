import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryDocumentStore } from "../src/store/memory.js";
import { readSeedFiles } from "../src/store/seed.js";

const TEN_MB = 10 * 1024 * 1024;

/** Concatenates renumbered seed clauses until the text exceeds `minChars`. */
function buildLargeContract(minChars: number): string {
  const clauses = readSeedFiles().flatMap((f) =>
    f.text.split(/\n(?=\d+\. )/).filter((c) => /^\d+\. /.test(c)),
  );
  const parts: string[] = ["Consolidated Master Agreement\n"];
  let size = parts[0]?.length ?? 0;
  for (let n = 1; size <= minChars; n++) {
    const clause = clauses[(n - 1) % clauses.length] ?? "";
    const renumbered = clause.replace(/^\d+\./, `${n}.`) + "\n";
    parts.push(renumbered);
    size += renumbered.length;
  }
  return parts.join("");
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("large documents (10 MB+)", () => {
  const text = buildLargeContract(TEN_MB);

  it("builds a 10 MB+ contract from seed clauses", () => {
    expect(text.length).toBeGreaterThan(TEN_MB);
  });

  it("round-trips intact through the store", () => {
    const store = new InMemoryDocumentStore();
    const doc = store.create({ title: "Large", text });
    expect(store.get(doc.id)?.text.length).toBe(text.length);
    expect(sha(store.get(doc.id)?.text ?? "")).toBe(sha(text));
  });

  it("round-trips intact through POST then GET /documents/:id", async () => {
    const app = createApp({ store: new InMemoryDocumentStore() });
    const started = performance.now();
    const created = await app.request("/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Large", text }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const got = await app.request(`/documents/${id}`);
    expect(got.status).toBe(200);
    const body = (await got.json()) as { text: string; version: number };
    expect(body.version).toBe(1);
    expect(body.text.length).toBe(text.length);
    expect(sha(body.text)).toBe(sha(text));

    const list = (await (await app.request("/documents")).json()) as {
      documents: { length: number }[];
    };
    expect(list.documents[0]?.length).toBe(text.length);
    // Generous ceiling: this is a tripwire for accidental quadratic work, not a benchmark.
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
