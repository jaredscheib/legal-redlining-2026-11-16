import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { MAX_CHANGES_PER_REQUEST } from "../config.js";
import type { PatchDocumentResponse } from "../domain/types.js";
import type { ErrorBody } from "../errors.js";
import { InMemoryDocumentStore } from "../store/memory.js";

const TEXT = "Payment is due within thirty (30) days. Late fees accrue after thirty (30) days.";

let store: InMemoryDocumentStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new InMemoryDocumentStore();
  store.create({ id: "doc", title: "Terms", text: TEXT });
  app = createApp({ store });
});

const patch = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const swap = (occurrence?: number) => ({
  changes: [
    {
      operation: "replace",
      target: { text: "thirty (30) days", ...(occurrence ? { occurrence } : {}) },
      replacement: "fifteen (15) days",
    },
  ],
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const errorOf = (res: Response) => res.json() as Promise<ErrorBody & { details: any }>;

describe("PATCH /documents/:id", () => {
  it("dry run returns the new text and redline but leaves the store unchanged", async () => {
    const res = await patch("/documents/doc?dryRun=true", swap(2));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchDocumentResponse;
    expect(body).toMatchObject({ id: "doc", version: 1, dryRun: true });
    expect(body.text).toBe(
      "Payment is due within thirty (30) days. Late fees accrue after fifteen (15) days.",
    );
    expect(body.redline).toHaveLength(1);
    expect(body.redline[0]).toMatchObject({
      changeIndex: 0,
      start: TEXT.lastIndexOf("thirty"),
      before: expect.stringContaining("Late fees accrue after "),
      after: ".",
    });
    expect(body.redline[0]?.segments.some((s) => s.type === "insert")).toBe(true);

    expect(store.get("doc")).toMatchObject({ text: TEXT, version: 1 });
    expect(store.history("doc")).toEqual([]);
  });

  it("applies: bumps the version, logs the op, and GET shows the new text", async () => {
    const res = await patch("/documents/doc?dryRun=false", swap());
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchDocumentResponse;
    expect(body).toMatchObject({ version: 2, dryRun: false });

    const got = (await (await app.request("/documents/doc")).json()) as PatchDocumentResponse;
    expect(got.version).toBe(2);
    expect(got.text).toBe(body.text);
    expect(got.text.startsWith("Payment is due within fifteen (15) days.")).toBe(true);
    expect(store.history("doc")?.[0]?.ops).toEqual([
      { start: 22, end: 38, oldText: "thirty (30) days", newText: "fifteen (15) days" },
    ]);
  });

  it("defaults to apply when dryRun is absent and deletes with an empty replacement", async () => {
    const res = await patch("/documents/doc", {
      changes: [{ operation: "replace", target: { text: " Late fees" }, replacement: "" }],
    });
    expect(res.status).toBe(200);
    expect(store.get("doc")?.text).toBe(
      "Payment is due within thirty (30) days. accrue after thirty (30) days.",
    );
  });

  it("404s an unknown document", async () => {
    const res = await patch("/documents/nope", swap());
    expect(res.status).toBe(404);
    expect((await errorOf(res)).details.reason).toBe("DOCUMENT_NOT_FOUND");
  });

  it.each([
    ["a wrong operation", { changes: [{ operation: "delete" }] }],
    [
      "an empty target",
      { changes: [{ operation: "replace", target: { text: "" }, replacement: "x" }] },
    ],
    [
      "occurrence 0",
      {
        changes: [{ operation: "replace", target: { text: "a", occurrence: 0 }, replacement: "x" }],
      },
    ],
    ["no changes", { changes: [] }],
    [
      `more than ${MAX_CHANGES_PER_REQUEST} changes`,
      { changes: Array.from({ length: MAX_CHANGES_PER_REQUEST + 1 }, () => swap().changes[0]) },
    ],
  ])("400s %s with zod issues", async (_name, body) => {
    const res = await patch("/documents/doc", body);
    expect(res.status).toBe(400);
    const err = await errorOf(res);
    expect(err.details.reason).toBe("INVALID_PAYLOAD");
    expect(err.details.issues.length).toBeGreaterThan(0);
    expect(store.get("doc")?.version).toBe(1);
  });

  it("400s a bad dryRun value", async () => {
    const res = await patch("/documents/doc?dryRun=yes", swap());
    expect(res.status).toBe(400);
    expect((await errorOf(res)).details.reason).toBe("INVALID_PAYLOAD");
  });

  it("422s TARGET_NOT_FOUND and changes nothing", async () => {
    const res = await patch("/documents/doc", {
      changes: [{ operation: "replace", target: { text: "ninety" }, replacement: "x" }],
    });
    expect(res.status).toBe(422);
    const err = await errorOf(res);
    expect(err.details).toEqual({ reason: "TARGET_NOT_FOUND", changeIndex: 0 });
    expect(store.get("doc")).toMatchObject({ text: TEXT, version: 1 });
  });

  it("422s OCCURRENCE_OUT_OF_RANGE with the count found and changes nothing", async () => {
    const res = await patch("/documents/doc", swap(3));
    expect(res.status).toBe(422);
    const err = await errorOf(res);
    expect(err.details).toEqual({ reason: "OCCURRENCE_OUT_OF_RANGE", changeIndex: 0, found: 2 });
    expect(store.get("doc")).toMatchObject({ text: TEXT, version: 1 });
  });
});

describe("PATCH /documents/:id with several changes", () => {
  const replace = (text: string, replacement: string, occurrence?: number) => ({
    operation: "replace",
    target: { text, ...(occurrence ? { occurrence } : {}) },
    replacement,
  });

  it("applies three changes in one version, one hunk per change with its changeIndex", async () => {
    const res = await patch("/documents/doc", {
      changes: [
        replace("thirty (30) days", "sixty (60) days", 2),
        replace("Payment", "Each payment"),
        replace("thirty (30) days", "fifteen (15) days", 1),
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchDocumentResponse;
    expect(body.version).toBe(2);
    expect(body.text).toBe(
      "Each payment is due within fifteen (15) days. Late fees accrue after sixty (60) days.",
    );
    expect(body.redline.map((h) => [h.changeIndex, h.start])).toEqual([
      [0, TEXT.lastIndexOf("thirty")],
      [1, 0],
      [2, TEXT.indexOf("thirty")],
    ]);
    expect(store.get("doc")).toMatchObject({ text: body.text, version: 2 });
    expect(store.history("doc")).toHaveLength(1);
  });

  it("422s OVERLAPPING_CHANGES and changes nothing", async () => {
    const res = await patch("/documents/doc", {
      changes: [replace("thirty (30) days", "x"), replace("(30) days. Late", "y")],
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).details.reason).toBe("OVERLAPPING_CHANGES");
    expect(store.get("doc")).toMatchObject({ text: TEXT, version: 1 });
    expect(store.history("doc")).toEqual([]);
  });

  it("422s with the failing change's index and applies none of the others", async () => {
    const res = await patch("/documents/doc", {
      changes: [replace("Payment", "Each payment"), replace("ninety", "x"), replace("Late", "L")],
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).details).toEqual({ reason: "TARGET_NOT_FOUND", changeIndex: 1 });
    expect(store.get("doc")).toMatchObject({ text: TEXT, version: 1 });
    expect(store.history("doc")).toEqual([]);
  });
});

describe("ETag and If-Match", () => {
  it("GET sets the version ETag", async () => {
    const res = await app.request("/documents/doc");
    expect(res.headers.get("ETag")).toBe('"v1"');
  });

  it("PATCH sets the ETag of the resulting version, and of the current one on a dry run", async () => {
    const dry = await patch("/documents/doc?dryRun=true", swap());
    expect(dry.headers.get("ETag")).toBe('"v1"');
    const applied = await patch("/documents/doc", swap());
    expect(applied.headers.get("ETag")).toBe('"v2"');
  });

  it.each(['"v1"', 'W/"v1"', "*", '"v7", "v1"'])("applies with If-Match %s", async (ifMatch) => {
    const res = await patch("/documents/doc", swap(), { "If-Match": ifMatch });
    expect(res.status).toBe(200);
    expect(store.get("doc")?.version).toBe(2);
  });

  it.each(["true", "false"])(
    "412s VERSION_CONFLICT on a stale If-Match (dryRun=%s) and changes nothing",
    async (dryRun) => {
      await patch("/documents/doc", swap());
      const res = await patch(`/documents/doc?dryRun=${dryRun}`, swap(), { "If-Match": '"v1"' });
      expect(res.status).toBe(412);
      expect((await errorOf(res)).details).toEqual({
        reason: "VERSION_CONFLICT",
        currentVersion: 2,
      });
      expect(store.get("doc")?.version).toBe(2);
      expect(store.history("doc")).toHaveLength(1);
    },
  );
});
