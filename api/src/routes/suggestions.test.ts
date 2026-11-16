import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogs } from "../../test/capture-logs.js";
import { appWith } from "../../test/http.js";
import type { LlmService, SuggestionInput } from "../domain/types.js";
import { createLlmClient } from "../llm/client.js";
import { createLlmService } from "../llm/service.js";
import { LlmUnavailable, type LlmTransport, type LlmUnavailableReason } from "../llm/types.js";
import { InMemoryDocumentStore } from "../store/memory.js";

const TEXT = "A".repeat(300) + "Customer may cancel." + "B".repeat(300);
const START = 300;
const END = 320;

function setup(suggest: LlmService["suggest"]) {
  const store = new InMemoryDocumentStore();
  store.create({ id: "doc", title: "Doc", text: TEXT });
  const llm: LlmService = { expand: async () => ({ added: [] }), suggest: vi.fn(suggest) };
  return { app: appWith({ store, llm }), llm, store };
}

const post = (range: { start: number; end: number }, instruction?: string) => ({
  method: "POST",
  headers: { "content-type": "application/json", "x-request-id": "req-7" },
  body: JSON.stringify({ range, instruction }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (res: Response) => res.json() as Promise<any>;

describe("POST /documents/:id/suggestions", () => {
  it("returns the suggestion and never writes", async () => {
    const { app, store } = setup(async ({ text }) => ({
      replacement: text.replace("cancel", "terminate"),
      rationale: "Uses the defined verb.",
      model: "fake",
    }));
    const res = await app.request("/documents/doc/suggestions", post({ start: START, end: END }));
    expect(res.status).toBe(200);
    expect(await read(res)).toEqual({
      replacement: "Customer may terminate.",
      rationale: "Uses the defined verb.",
      model: "fake",
    });
    expect(store.get("doc")?.version).toBe(1);
    expect(store.get("doc")?.text).toBe(TEXT);
  });

  it("sends the passage with up to 200 chars of context, clipped at the document edges", async () => {
    const seen: SuggestionInput[] = [];
    const { app } = setup(async (input) => {
      seen.push(input);
      return { replacement: "x", rationale: "r", model: "fake" };
    });
    await app.request("/documents/doc/suggestions", post({ start: START, end: END }, "Tighten"));
    await app.request("/documents/doc/suggestions", post({ start: 0, end: 10 }));
    await app.request(
      "/documents/doc/suggestions",
      post({ start: TEXT.length - 5, end: TEXT.length }),
    );
    expect(seen[0]).toEqual({
      text: "Customer may cancel.",
      contextBefore: "A".repeat(200),
      contextAfter: "B".repeat(200),
      instruction: "Tighten",
    });
    expect(seen[1]).toMatchObject({ text: "A".repeat(10), contextBefore: "" });
    expect(seen[1]?.contextAfter).toBe(TEXT.slice(10, 210));
    expect(seen[2]).toMatchObject({ text: "B".repeat(5), contextAfter: "" });
    expect(seen[2]?.contextBefore).toHaveLength(200);
  });

  const cases: [LlmUnavailableReason, number, string][] = [
    ["no_api_key", 503, "LLM_UNAVAILABLE"],
    ["timeout", 503, "LLM_UNAVAILABLE"],
    ["no_recording", 503, "LLM_UNAVAILABLE"],
    ["api_error", 503, "LLM_UNAVAILABLE"],
    ["refusal", 502, "LLM_ERROR"],
    ["invalid_output", 502, "LLM_ERROR"],
  ];
  for (const [reason, status, code] of cases) {
    it(`maps LlmUnavailable(${reason}) to ${status} ${code}`, async () => {
      const { app } = setup(async () => {
        throw new LlmUnavailable(reason, "internal detail abc123");
      });
      const res = await app.request("/documents/doc/suggestions", post({ start: 0, end: 10 }));
      expect(res.status).toBe(status);
      const body = await read(res);
      expect(body.details).toEqual({ reason: code, llmReason: reason });
      expect(JSON.stringify(body)).not.toContain("abc123");
    });
  }

  it("any other error is a 500 with no detail", async () => {
    const { app } = setup(async () => {
      throw new TypeError("boom");
    });
    const res = await app.request("/documents/doc/suggestions", post({ start: 0, end: 10 }));
    expect(res.status).toBe(500);
  });

  it("validates before calling the model", async () => {
    const { app, llm } = setup(async () => ({ replacement: "", rationale: "", model: "" }));
    const res = await app.request("/documents/doc/suggestions", post({ start: 0, end: 10_000 }));
    expect(res.status).toBe(400);
    expect(llm.suggest).not.toHaveBeenCalled();
  });
});

describe("request id through the LLM path", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suggest-route-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("the llm.call line inside a request carries its reqId, and no passage text", async () => {
    const transport = vi.fn<LlmTransport>(async (req) => ({
      text: JSON.stringify({ replacement: "Customer may terminate.", rationale: "r" }),
      stopReason: "end_turn",
      model: req.model,
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));
    const client = createLlmClient({
      mode: "live",
      transport,
      fixturesDir: path.join(dir, "f"),
      ledgerPath: path.join(dir, "l.jsonl"),
    });
    const store = new InMemoryDocumentStore();
    store.create({ id: "doc", title: "Doc", text: TEXT });
    const app = appWith({ store, llm: createLlmService(client) });
    let res: Response | undefined;
    const { events, raw } = await captureLogs(async () => {
      res = await app.request("/documents/doc/suggestions", post({ start: START, end: END }));
    });
    expect(res?.status).toBe(200);
    expect(res?.headers.get("x-request-id")).toBe("req-7");
    expect(events.find((e) => e.event === "llm.call")).toMatchObject({
      reqId: "req-7",
      op: "suggest",
      model: "claude-sonnet-5-5",
      status: "ok",
    });
    expect(events.find((e) => e.event === "http.request")).toMatchObject({
      reqId: "req-7",
      route: "/documents/:id/suggestions",
      status: 200,
    });
    expect(raw.join("")).not.toContain("Customer may");
  });
});
