import { beforeEach, describe, expect, it } from "vitest";
import { appWith, expectError, jsonInit, readJson } from "../test/http.js";
import { InMemoryDocumentStore } from "./store/memory.js";
import { seedStore } from "./store/seed.js";

let store: InMemoryDocumentStore;
let app: ReturnType<typeof appWith>;

beforeEach(() => {
  store = new InMemoryDocumentStore();
  seedStore(store);
  app = appWith({ store });
});

describe("GET /healthz", () => {
  it("reports ok and the version", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
  });
});

describe("documents", () => {
  it("lists the 4 seed contracts with metadata only", async () => {
    const res = await app.request("/documents");
    expect(res.status).toBe(200);
    const { documents } = await readJson(res);
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
    const body = await readJson(res);
    expect(body).toMatchObject({ id: "saas-msa", title: "SaaS Master Services Agreement" });
    expect(body.text).toContain("Customer may cancel this Agreement");
    expect(body.version).toBe(1);
  });

  it("404s an unknown document with DOCUMENT_NOT_FOUND", async () => {
    const res = await app.request("/documents/nope");
    expect(res.status).toBe(404);
    expectError(await readJson(res), 404, "DOCUMENT_NOT_FOUND");
  });

  it("creates a document (201) and can read it back", async () => {
    const res = await app.request(
      "/documents",
      jsonInit("POST", { title: "Side Letter", text: "1. Hi." }),
    );
    expect(res.status).toBe(201);
    const created = await readJson(res);
    expect(created).toMatchObject({ title: "Side Letter", text: "1. Hi.", version: 1 });
    const again = await app.request(`/documents/${created.id}`);
    expect((await readJson(again)).text).toBe("1. Hi.");
  });

  it("400s an invalid payload with zod issues", async () => {
    const res = await app.request("/documents", jsonInit("POST", { title: "" }));
    expect(res.status).toBe(400);
    const body = await readJson(res);
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
    expectError(await readJson(res), 400, "INVALID_PAYLOAD");
  });
});

describe("errors", () => {
  it("404s an unknown route with the error shape", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expectError(await readJson(res), 404, "ROUTE_NOT_FOUND");
  });

  it.each([
    ["DELETE", "/documents/saas-msa", "GET, HEAD, PATCH"],
    ["PUT", "/documents/saas-msa", "GET, HEAD, PATCH"],
    ["GET", "/documents/saas-msa/suggestions", "POST"],
    ["POST", "/search", "GET, HEAD"],
    ["DELETE", "/documents", "GET, HEAD, POST"],
    ["POST", "/healthz", "GET, HEAD"],
  ])("405s %s %s with METHOD_NOT_ALLOWED and Allow: %s", async (method, path, allow) => {
    const res = await app.request(path, { method });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe(allow);
    const body = await readJson(res);
    expectError(body, 405, "METHOD_NOT_ALLOWED");
    expect(body.details.allowed).toEqual(allow.split(", "));
    expect(store.get("saas-msa")?.version).toBe(1);
  });

  it.each([
    ["GET", "/documents/saas-msa/history"],
    ["DELETE", "/nope"],
    ["GET", "/documents/"],
  ])("still 404s %s %s, an unknown path", async (method, path) => {
    const res = await app.request(path, { method });
    expect(res.status).toBe(404);
    expect(res.headers.get("Allow")).toBeNull();
    expectError(await readJson(res), 404, "ROUTE_NOT_FOUND");
  });

  it("500s an unexpected throw without leaking the message or stack", async () => {
    const broken = new InMemoryDocumentStore();
    broken.list = () => {
      throw new Error("secret internal detail");
    };
    const res = await appWith({ store: broken }).request("/documents");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Internal error", code: 500 });
    expect(text).not.toContain("secret");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("input validation", () => {
  it("GET /search validates its query", async () => {
    const res = await app.request("/search?limit=0");
    expect(res.status).toBe(400);
    expectError(await readJson(res), 400, "INVALID_PAYLOAD");
  });

  it("POST /documents/:id/suggestions validates its range", async () => {
    const res = await app.request(
      "/documents/saas-msa/suggestions",
      jsonInit("POST", { range: { start: 0, end: 401 } }),
    );
    expect(res.status).toBe(400);
    expectError(await readJson(res), 400, "INVALID_PAYLOAD");
  });
});
