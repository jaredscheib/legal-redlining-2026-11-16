import { describe, expect, it } from "vitest";
import { captureLogs } from "../test/capture-logs.js";
import { createApp } from "./app.js";
import { acceptRequestId } from "./request-id.js";
import { createSearchService } from "./search/service.js";
import { InMemoryDocumentStore } from "./store/memory.js";
import { seedStore } from "./store/seed.js";

function app() {
  const store = new InMemoryDocumentStore();
  seedStore(store);
  return createApp({ store, search: createSearchService({ store }) });
}

describe("acceptRequestId", () => {
  it("keeps a short safe id and replaces anything else", () => {
    expect(acceptRequestId("abc-123_X.y")).toBe("abc-123_X.y");
    for (const bad of [undefined, "", "a b", "x".repeat(65), "<script>", "id\nforged"]) {
      const id = acceptRequestId(bad);
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe("request-id middleware", () => {
  it("echoes a safe incoming id and mints one otherwise", async () => {
    const a = app();
    const kept = await a.request("/healthz", { headers: { "x-request-id": "client-42" } });
    expect(kept.headers.get("x-request-id")).toBe("client-42");
    const minted = await a.request("/healthz", { headers: { "x-request-id": "bad id!" } });
    expect(minted.headers.get("x-request-id")).toMatch(/^[0-9a-f]{16}$/);
    const errored = await a.request("/nope");
    expect(errored.status).toBe(404);
    expect(errored.headers.get("x-request-id")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("logs http.request with the route pattern, and reqId on lines inside the request", async () => {
    const a = app();
    const { events, raw } = await captureLogs(async () => {
      await a.request("/search?q=secretword+rent", { headers: { "x-request-id": "r1" } });
      await a.request("/documents/saas-msa", { headers: { "x-request-id": "r2" } });
      await a.request("/no/such/route", { headers: { "x-request-id": "r3" } });
    });
    const access = events.filter((e) => e.event === "http.request");
    expect(access).toEqual([
      expect.objectContaining({ reqId: "r1", method: "GET", route: "/search", status: 200 }),
      expect.objectContaining({ reqId: "r2", route: "/documents/:id", status: 200 }),
      expect.objectContaining({ reqId: "r3", route: "unmatched", status: 404 }),
    ]);
    for (const e of access) expect(typeof e.ms).toBe("number");
    expect(events.find((e) => e.event === "search")).toMatchObject({ reqId: "r1" });
    const text = raw.join("");
    expect(text).not.toContain("secretword");
    expect(text).not.toContain("saas-msa"); // the raw path never appears in the access log
  });

  it("the 500 handler reuses the request id in its header and its log line", async () => {
    const store = new InMemoryDocumentStore();
    store.list = () => {
      throw new Error("secret internal detail");
    };
    let res: Response | undefined;
    const { events, raw } = await captureLogs(async () => {
      res = await createApp({ store }).request("/documents", {
        headers: { "x-request-id": "boom-1" },
      });
    });
    expect(res?.status).toBe(500);
    expect(res?.headers.get("x-request-id")).toBe("boom-1");
    expect(events.find((e) => e.event === "http.unhandled")).toMatchObject({
      reqId: "boom-1",
      route: "/documents",
      errorName: "Error",
    });
    expect(events.find((e) => e.event === "http.request")).toMatchObject({
      reqId: "boom-1",
      status: 500,
    });
    expect(raw.join("")).not.toContain("secret internal");
  });
});
