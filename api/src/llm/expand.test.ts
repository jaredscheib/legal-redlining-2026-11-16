import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmClient } from "./client.js";
import {
  LruCache,
  cacheKey,
  createExpander,
  selectAlternatives,
  type ExpansionOutput,
} from "./expand.js";
import { LlmUnavailable, type LlmTransport } from "./types.js";

const usage = { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "expand-test-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function clientWith(transport: LlmTransport) {
  return createLlmClient({
    mode: "live",
    transport,
    fixturesDir: path.join(dir, "fixtures"),
    ledgerPath: path.join(dir, "ledger.jsonl"),
  });
}

const replying = (output: ExpansionOutput) =>
  vi.fn<LlmTransport>(async (req) => ({
    text: JSON.stringify(output),
    stopReason: "end_turn",
    model: req.model,
    usage,
  }));

describe("selectAlternatives", () => {
  it("lowercases, dedupes and drops alternatives already in the query", () => {
    const added = selectAlternatives(["terminate", "convenience"], {
      expansions: [
        { term: "terminate", alternatives: ["Cancel", "cancel", "TERMINATE", " end  "] },
        { term: "convenience", alternatives: ['"for any reason"', "Cancel", "convenience"] },
      ],
    });
    expect(added).toEqual(["cancel", "end", "for any reason"]);
  });

  it("caps at 3 per term or phrase and 9 overall", () => {
    const many = (p: string) => Array.from({ length: 6 }, (_, i) => `${p}${i}`);
    const added = selectAlternatives(["a", "b", "c", "d"], {
      expansions: ["a", "b", "c", "d"].map((t) => ({ term: t, alternatives: many(`${t}x`) })),
    });
    expect(added).toEqual(["ax0", "ax1", "ax2", "bx0", "bx1", "bx2", "cx0", "cx1", "cx2"]);
  });

  it("passes a grouped phrase and multi-word alternatives through whole", () => {
    const added = selectAlternatives(["confidential", "information", "breach"], {
      expansions: [
        {
          term: "confidential information",
          alternatives: ["Proprietary Information", "trade secrets", "information confidential"],
        },
        { term: "breach", alternatives: ["default", "violation"] },
      ],
    });
    // "information confidential" only reorders query words, so it adds nothing.
    expect(added).toEqual(["proprietary information", "trade secrets", "default", "violation"]);
  });

  it("drops empty and punctuation-only alternatives", () => {
    expect(
      selectAlternatives(["x"], { expansions: [{ term: "x", alternatives: ["", " - ", "the"] }] }),
    ).toEqual([]);
  });
});

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const c = new LruCache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBe(1); // a is now most recent
    c.set("c", 3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.size).toBe(2);
  });

  it("keys on the normalized term list, in order", () => {
    expect(cacheKey(["Terminate", " convenience"])).toBe(cacheKey(["terminate", "convenience"]));
    expect(cacheKey(["a", "b"])).not.toBe(cacheKey(["b", "a"]));
  });
});

describe("createExpander", () => {
  it("sends the terms in order to the expansion model at effort low, thinking off", async () => {
    const transport = replying({
      expansions: [{ term: "terminate", alternatives: ["cancel", "rescind"] }],
    });
    const expand = createExpander(clientWith(transport));
    expect(await expand(["terminate", "convenience"])).toEqual({ added: ["cancel", "rescind"] });
    const req = transport.mock.calls[0]?.[0];
    expect(req).toMatchObject({
      model: "claude-haiku-5-5",
      effort: "low",
      thinking: "disabled",
      maxTokens: 200,
    });
    expect(req?.messages[0]?.content).toBe('Terms: ["terminate","convenience"]');
  });

  it("serves a repeated term list from the cache without a second call", async () => {
    const transport = replying({ expansions: [{ term: "lease", alternatives: ["tenancy"] }] });
    const expand = createExpander(clientWith(transport));
    const first = await expand(["lease"]);
    const second = await expand(["Lease"]);
    expect(second).toEqual(first);
    expect(transport).toHaveBeenCalledTimes(1);
    if ("added" in first) first.added.push("mutated"); // callers cannot poison the cache
    expect(await expand(["lease"])).toEqual({ added: ["tenancy"] });
  });

  it("maps a timeout to skipped and does not cache it", async () => {
    const transport = vi.fn<LlmTransport>(async () => {
      throw new LlmUnavailable("timeout", "no response within 2500 ms");
    });
    const expand = createExpander(clientWith(transport));
    expect(await expand(["lease"])).toEqual({ skipped: "timeout" });
    expect(await expand(["lease"])).toEqual({ skipped: "timeout" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("maps invalid output to its reason and any other error to llm_error", async () => {
    const bad = vi.fn<LlmTransport>(async (req) => ({
      text: "not json",
      stopReason: "max_tokens",
      model: req.model,
      usage,
    }));
    expect(await createExpander(clientWith(bad))(["x"])).toEqual({ skipped: "invalid_output" });

    const boom = vi.fn<LlmTransport>(async () => {
      throw new TypeError("socket hang up");
    });
    expect(await createExpander(clientWith(boom))(["x"])).toEqual({ skipped: "llm_error" });
  });

  it("replay mode with no recording skips with no_recording", async () => {
    const client = createLlmClient({
      mode: "replay",
      fixturesDir: path.join(dir, "none"),
      ledgerPath: path.join(dir, "ledger.jsonl"),
    });
    expect(await createExpander(client)(["x"])).toEqual({ skipped: "no_recording" });
  });
});
