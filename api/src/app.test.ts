import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("prefixes the commit with the release when APP_RELEASE is set", async () => {
    try {
      vi.stubEnv("GIT_SHA", "abc1234");
      vi.stubEnv("APP_RELEASE", "v0.1.0");
      expect((await readJson(await app.request("/healthz"))).version).toBe("v0.1.0 (abc1234)");
      vi.stubEnv("APP_RELEASE", "");
      expect((await readJson(await app.request("/healthz"))).version).toBe("abc1234");
    } finally {
      vi.unstubAllEnvs();
    }
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

  it("400s malformed JSON and says so", async () => {
    const res = await app.request("/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expectError(body, 400, "INVALID_PAYLOAD");
    expect(body.error).toBe("request body is not valid JSON");
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

  it.each([
    ["/search?q=rent&limit=0", "limit: must be at least 1"],
    ["/search?limit=5", "q: is required"],
  ])("GET %s says what is wrong: %s", async (url, error) => {
    const body = await readJson(await app.request(url));
    expect(body.error).toBe(error);
    expect(body.details.issues.length).toBeGreaterThan(0);
  });

  it.each([
    [{ title: "", text: "x" }, "title: must not be empty"],
    [{ title: "T" }, "text: is required"],
  ])("POST /documents %j says what is wrong: %s", async (payload, error) => {
    const body = await readJson(await app.request("/documents", jsonInit("POST", payload)));
    expect(body.error).toBe(error);
  });

  describe("strict: unknown keys are a 400, never dropped", () => {
    const target = { text: "Customer may cancel this Agreement" };
    const change = (extra: Record<string, unknown>) => ({
      operation: "replace",
      replacement: "x",
      ...extra,
    });

    it.each([
      [
        "a misspelled occurrence",
        "/documents/saas-msa",
        { changes: [change({ target: { ...target, occurence: 3 } })] },
        'changes[0].target: unrecognized key "occurence"',
      ],
      [
        "a misspelled expectedText",
        "/documents/saas-msa",
        { changes: [change({ range: { start: 0, end: 1, expected_text: "x" } })] },
        'changes[0].range: unrecognized key "expected_text"',
      ],
      [
        "an unknown key on a change",
        "/documents/saas-msa",
        { changes: [change({ target, note: "hi" })] },
        'changes[0]: unrecognized key "note"',
      ],
      [
        "an unknown top-level key",
        "/documents/saas-msa",
        { changes: [change({ target })], dryRun: true },
        'body: unrecognized key "dryRun"',
      ],
      [
        "a lowercase dryrun in the query",
        "/documents/saas-msa?dryrun=true",
        { changes: [change({ target })] },
        'query: unrecognized key "dryrun"',
      ],
      [
        "both target and range",
        "/documents/saas-msa",
        { changes: [change({ target, range: { start: 0, end: 1 } })] },
        'changes[0]: must have exactly one of "target" or "range"',
      ],
      [
        "neither target nor range",
        "/documents/saas-msa",
        { changes: [change({})] },
        'changes[0]: must have exactly one of "target" or "range"',
      ],
      [
        "a wrong operation",
        "/documents/saas-msa",
        { changes: [change({ operation: "delete", target })] },
        'changes[0].operation: must be "replace"',
      ],
    ])("PATCH: %s", async (_name, url, payload, error) => {
      const res = await app.request(url, jsonInit("PATCH", payload));
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expectError(body, 400, "INVALID_PAYLOAD");
      expect(body.error).toBe(error);
      expect(store.get("saas-msa")?.version).toBe(1);
      expect(store.history("saas-msa")).toEqual([]);
    });

    it.each([
      ["/documents", { title: "T", text: "x", id: "mine" }, 'body: unrecognized key "id"'],
      [
        "/documents/saas-msa/suggestions",
        { range: { start: 0, end: 5 }, instructions: "shorter" },
        'body: unrecognized key "instructions"',
      ],
      [
        "/documents/saas-msa/suggestions",
        { range: { start: 0, end: 5, expectedText: "x" } },
        'range: unrecognized key "expectedText"',
      ],
    ])("POST %s %j", async (url, payload, error) => {
      const res = await app.request(url, jsonInit("POST", payload));
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toBe(error);
      expect(store.list()).toHaveLength(4);
    });

    it("GET /search rejects an unknown parameter", async () => {
      const res = await app.request("/search?q=rent&lmit=5");
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toBe('query: unrecognized key "lmit"');
    });

    it.each([
      "/search?q=rent",
      "/search?q=rent&docId=saas-msa",
      "/search?q=rent&docId=saas-msa&docId=mutual-nda&limit=5&offset=0&expand=false",
    ])("GET %s still passes", async (url) => {
      expect((await app.request(url)).status).toBe(200);
    });
  });

  describe("a body must be application/json", () => {
    const valid = { title: "Side Letter", text: "1. Hi." };

    it.each([
      ["form-urlencoded (curl -d without -H)", "application/x-www-form-urlencoded", "title=x"],
      ["text/plain", "text/plain;charset=UTF-8", JSON.stringify(valid)],
      ["a +json type", "application/merge-patch+json", JSON.stringify(valid)],
    ])("415s %s", async (_name, type, body) => {
      const res = await app.request("/documents", {
        method: "POST",
        headers: { "content-type": type },
        body,
      });
      expect(res.status).toBe(415);
      const err = await readJson(res);
      expectError(err, 415, "UNSUPPORTED_MEDIA_TYPE");
      expect(err.error).toBe(`Content-Type must be application/json, not ${type.split(";")[0]}`);
      expect(store.list()).toHaveLength(4);
    });

    it("415s a body with no Content-Type", async () => {
      const res = await app.request("/documents", {
        method: "POST",
        body: new TextEncoder().encode(JSON.stringify(valid)),
      });
      expect(res.status).toBe(415);
      expectError(await readJson(res), 415, "UNSUPPORTED_MEDIA_TYPE");
    });

    it("400s no body and no Content-Type as not JSON", async () => {
      const res = await app.request("/documents", { method: "POST" });
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toBe("request body is not valid JSON");
    });

    it.each(["application/json; charset=utf-8", "Application/JSON;charset=UTF-8"])(
      "accepts %s",
      async (type) => {
        const res = await app.request("/documents", {
          method: "POST",
          headers: { "content-type": type },
          body: JSON.stringify(valid),
        });
        expect(res.status).toBe(201);
      },
    );

    it.each([
      ["PATCH", "/documents/saas-msa"],
      ["PATCH", "/documents/nope"],
      ["PATCH", "/documents/saas-msa?dryrun=true"],
      ["POST", "/documents/saas-msa/suggestions"],
      ["POST", "/documents/nope/suggestions"],
    ])(
      "%s %s with a form body is 415, before validation and the document lookup",
      async (method, url) => {
        const res = await app.request(url, {
          method,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "changes=x",
        });
        expect(res.status).toBe(415);
        expect(store.get("saas-msa")?.version).toBe(1);
      },
    );

    it("an unknown document with an invalid JSON body is still a 400 before the 404", async () => {
      const res = await app.request("/documents/nope", jsonInit("PATCH", { changes: [] }));
      expect(res.status).toBe(400);
    });
  });

  it("a suggestion's error names the field and the limit", async () => {
    const res = await app.request(
      "/documents/saas-msa/suggestions",
      jsonInit("POST", { range: { start: 0, end: 10 }, instruction: "x".repeat(1001) }),
    );
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error).toBe("instruction: must be at most 1000 characters");
    expect(body.details.issues[0]).toMatchObject({ code: "too_big", path: ["instruction"] });
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
