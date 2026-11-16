import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { SearchResponse } from "../domain/types.js";
import type { ErrorBody } from "../errors.js";
import { createRuntime } from "../runtime.js";

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  // The production wiring: seeded store plus search, no expander.
  app = createApp(createRuntime().deps);
});

const get = async (url: string) => {
  const res = await app.request(url);
  return { status: res.status, body: (await res.json()) as SearchResponse & ErrorBody };
};

describe("GET /search against the seed contracts", () => {
  it('"confidential information" returns NDA passages first', async () => {
    const { status, body } = await get("/search?q=confidential%20information");
    expect(status).toBe(200);
    expect(body.terms).toEqual(["confidential", "information"]);
    expect(body.expansion).toEqual({ status: "off", added: [] });
    expect(body.total).toBeGreaterThan(3);
    expect(body.results.slice(0, 3).map((r) => r.docId)).toEqual([
      "mutual-nda",
      "mutual-nda",
      "mutual-nda",
    ]);
    const top = body.results[0];
    expect(top?.matchedTerms).toEqual(["confidential", "information"]);
    expect(top?.snippet.length).toBeLessThanOrEqual(400);
  });

  it("offsets point into the document and highlights are exact", async () => {
    const { body } = await get("/search?q=security%20deposit&limit=5");
    const doc = (await (await app.request("/documents/commercial-lease")).json()) as {
      text: string;
    };
    const lease = body.results.filter((r) => r.docId === "commercial-lease");
    expect(lease.length).toBeGreaterThan(0);
    for (const hit of lease) {
      expect(doc.text.slice(hit.start, hit.end)).toBe(hit.snippet);
      for (const h of hit.highlights) {
        expect(["security", "deposit"]).toContain(hit.snippet.slice(h.start, h.end).toLowerCase());
      }
    }
  });

  it("a quoted phrase is exact and pages with limit/offset/total", async () => {
    const { body } = await get("/search?q=%22late%20charge%22");
    expect(body.phrases).toEqual(["late charge"]);
    expect(body.total).toBe(1);
    expect(body.results[0]?.snippet).toContain("late charge equal to five percent");

    const all = await get("/search?q=agreement&limit=100");
    const page = await get("/search?q=agreement&limit=3&offset=2");
    expect(page.body.total).toBe(all.body.total);
    expect(page.body.results).toEqual(all.body.results.slice(2, 5));
  });

  it("filters by repeated docId", async () => {
    const { body } = await get("/search?q=terminate&docId=saas-msa&docId=mutual-nda&limit=50");
    expect(body.total).toBeGreaterThan(0);
    expect(new Set(body.results.map((r) => r.docId))).toEqual(new Set(["saas-msa", "mutual-nda"]));
  });

  it("404s an unknown docId", async () => {
    const { status, body } = await get("/search?q=rent&docId=nope");
    expect(status).toBe(404);
    expect(body.details?.reason).toBe("DOCUMENT_NOT_FOUND");
  });

  it("finds a document created through the API", async () => {
    const created = await app.request("/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Side letter", text: "The parties agree on xylophones." }),
    });
    expect(created.status).toBe(201);
    const { body } = await get("/search?q=xylophones");
    expect(body.results[0]?.title).toBe("Side letter");
  });
});
