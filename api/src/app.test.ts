import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { ErrorBody } from "./errors.js";
import { InMemoryDocumentStore } from "./store/memory.js";
import { seedStore } from "./store/seed.js";

let store: InMemoryDocumentStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new InMemoryDocumentStore();
  seedStore(store);
  app = createApp({ store });
});

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Tests poke at response JSON freely; the shapes are asserted, not trusted. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (res: Response) => res.json() as Promise<any>;

function expectError(body: ErrorBody, code: number, reason?: string) {
  expect(typeof body.error).toBe("string");
  expect(body.code).toBe(code);
  if (reason) expect(body.details?.reason).toBe(reason);
}

describe("GET /healthz", () => {
  it("reports ok and the version", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
  });
});

describe("documents", () => {
  it("lists the 4 seed contracts with metadata only", async () => {
    const res = await app.request("/documents");
    expect(res.status).toBe(200);
    const { documents } = await read(res);
    expect(documents).toHaveLength(4);
    for (const d of documents) {
      expect(Object.keys(d).sort()).toEqual(["id", "length", "title", "version"]);
      expect(d.version).toBe(1);
      expect(d.length).toBeGreaterThan(1000);
    }
    expect(documents.map((d: { title: string }) => d.title)).toContain(
      "Mutual Non-Disclosure Agreement",
    );
  });

  it("gets one document", async () => {
    const res = await app.request("/documents/saas-msa");
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body).toMatchObject({ id: "saas-msa", title: "SaaS Master Services Agreement" });
    expect(body.text).toContain("Customer may cancel this Agreement");
    expect(body.version).toBe(1);
  });

  it("404s an unknown document with DOCUMENT_NOT_FOUND", async () => {
    const res = await app.request("/documents/nope");
    expect(res.status).toBe(404);
    expectError(await read(res), 404, "DOCUMENT_NOT_FOUND");
  });

  it("creates a document (201) and can read it back", async () => {
    const res = await app.request("/documents", json({ title: "Side Letter", text: "1. Hi." }));
    expect(res.status).toBe(201);
    const created = await read(res);
    expect(created).toMatchObject({ title: "Side Letter", text: "1. Hi.", version: 1 });
    const again = await app.request(`/documents/${created.id}`);
    expect((await read(again)).text).toBe("1. Hi.");
  });

  it("400s an invalid payload with zod issues", async () => {
    const res = await app.request("/documents", json({ title: "" }));
    expect(res.status).toBe(400);
    const body = await read(res);
    expectError(body, 400, "INVALID_PAYLOAD");
    expect(Array.isArray(body.details.issues)).toBe(true);
    expect(body.details.issues.length).toBeGreaterThan(0);
  });

  it("400s malformed JSON", async () => {
    const res = await app.request("/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expectError(await read(res), 400, "INVALID_PAYLOAD");
  });
});

describe("errors", () => {
  it("404s an unknown route with the error shape", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expectError(await read(res), 404, "ROUTE_NOT_FOUND");
  });

  it("500s an unexpected throw without leaking the message or stack", async () => {
    const broken = new InMemoryDocumentStore();
    broken.list = () => {
      throw new Error("secret internal detail");
    };
    const res = await createApp({ store: broken }).request("/documents");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Internal error", code: 500 });
    expect(text).not.toContain("secret");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("stubs return 501 NOT_IMPLEMENTED after validating input", () => {
  const patchBody = {
    changes: [{ operation: "replace", target: { text: "cancel" }, replacement: "terminate" }],
  };

  it("PATCH /documents/:id", async () => {
    const res = await app.request("/documents/saas-msa?dryRun=true", {
      ...json(patchBody),
      method: "PATCH",
    });
    expect(res.status).toBe(501);
    expectError(await read(res), 501, "NOT_IMPLEMENTED");
  });

  it("PATCH /documents/:id validates its body", async () => {
    const res = await app.request("/documents/saas-msa", {
      ...json({ changes: [{ operation: "delete" }] }),
      method: "PATCH",
    });
    expect(res.status).toBe(400);
    expectError(await read(res), 400, "INVALID_PAYLOAD");
  });

  it("PATCH /documents/:id 404s an unknown document", async () => {
    const res = await app.request("/documents/nope", { ...json(patchBody), method: "PATCH" });
    expect(res.status).toBe(404);
  });

  it("GET /documents/:id/changes", async () => {
    const res = await app.request("/documents/saas-msa/changes");
    expect(res.status).toBe(501);
    expectError(await read(res), 501, "NOT_IMPLEMENTED");
  });

  it("GET /search", async () => {
    const res = await app.request("/search?q=terminate&docId=saas-msa&docId=mutual-nda&limit=5");
    expect(res.status).toBe(501);
    expectError(await read(res), 501, "NOT_IMPLEMENTED");
  });

  it("GET /search validates its query", async () => {
    const res = await app.request("/search?limit=0");
    expect(res.status).toBe(400);
    expectError(await read(res), 400, "INVALID_PAYLOAD");
  });

  it("POST /documents/:id/suggestions", async () => {
    const res = await app.request(
      "/documents/saas-msa/suggestions",
      json({ range: { start: 0, end: 20 }, instruction: "Tighten this." }),
    );
    expect(res.status).toBe(501);
    expectError(await read(res), 501, "NOT_IMPLEMENTED");
  });

  it("POST /documents/:id/suggestions validates its range", async () => {
    const res = await app.request(
      "/documents/saas-msa/suggestions",
      json({ range: { start: 0, end: 401 } }),
    );
    expect(res.status).toBe(400);
    expectError(await read(res), 400, "INVALID_PAYLOAD");
  });
});
