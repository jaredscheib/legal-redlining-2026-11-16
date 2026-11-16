import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLlmClient, jsonSchemaOf } from "./client.js";
import { appendLedger, costUsd, readLedger, summarizeLedger } from "./ledger.js";
import { CassetteStore, canonicalJson, cassetteKey } from "./replay.js";
import { LlmUnavailable, type CanonicalRequest, type LlmTransport } from "./types.js";

const Suggestion = z.object({ replacement: z.string(), rationale: z.string() });

const input = {
  op: "suggest",
  model: "claude-sonnet-5-5",
  system: "You redline contracts.",
  messages: [{ role: "user" as const, content: "Tighten: Customer may cancel." }],
  schema: Suggestion,
  maxTokens: 1024,
  effort: "low" as const,
  timeoutMs: 1000,
};

const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };

function fakeTransport(text = '{"replacement":"Customer may terminate.","rationale":"clearer"}') {
  return vi.fn<LlmTransport>(async (req) => ({
    text,
    stopReason: "end_turn",
    model: req.model,
    usage,
  }));
}

let dir: string;
let fixturesDir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-test-"));
  fixturesDir = path.join(dir, "fixtures");
  ledgerPath = path.join(dir, "ledger.jsonl");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("replay key", () => {
  const base: CanonicalRequest = {
    model: "claude-sonnet-5-5",
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    schema: jsonSchemaOf(Suggestion),
    maxTokens: 100,
    effort: "low",
  };

  it("is a stable sha256 hex independent of key order", () => {
    const shuffled = Object.fromEntries(Object.entries(base).reverse()) as CanonicalRequest;
    expect(cassetteKey(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(cassetteKey(shuffled)).toBe(cassetteKey(base));
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });

  it("changes when any keyed field changes", () => {
    const k = cassetteKey(base);
    expect(cassetteKey({ ...base, model: "other" })).not.toBe(k);
    expect(cassetteKey({ ...base, system: "t" })).not.toBe(k);
    expect(cassetteKey({ ...base, messages: [{ role: "user", content: "yo" }] })).not.toBe(k);
    expect(cassetteKey({ ...base, schema: jsonSchemaOf(z.object({ x: z.string() })) })).not.toBe(k);
    expect(cassetteKey({ ...base, maxTokens: 101 })).not.toBe(k);
    expect(cassetteKey({ ...base, effort: "high" })).not.toBe(k);
    expect(cassetteKey({ ...base, thinking: "disabled" })).not.toBe(k);
  });

  it("an unset thinking field hashes like a request without it", () => {
    expect(cassetteKey({ ...base, thinking: undefined })).toBe(cassetteKey(base));
  });
});

describe("per-call model", () => {
  it("records one cassette per model and bills each at its own price", async () => {
    const transport = fakeTransport();
    const client = createLlmClient({ mode: "record", transport, fixturesDir, ledgerPath });
    const sonnet = await client.call(input);
    const haiku = await client.call({ ...input, model: "claude-haiku-5-5" });
    expect(haiku.replayed).toBe(false);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]?.[0].model).toBe("claude-haiku-5-5");
    expect(fs.readdirSync(fixturesDir)).toHaveLength(2);
    expect(sonnet.costUsd).toBeCloseTo(0.004, 10);
    expect(haiku.costUsd).toBeCloseTo(0.0002, 10); // 1000*$0.10/M + 200*$0.50/M
  });
});

describe("createLlmClient modes", () => {
  it("record: a miss calls live, writes a cassette and a ledger line; the next call replays", async () => {
    const transport = fakeTransport();
    const client = createLlmClient({ mode: "record", transport, fixturesDir, ledgerPath });

    const first = await client.call(input);
    expect(first.replayed).toBe(false);
    expect(first.output.replacement).toBe("Customer may terminate.");
    expect(first.costUsd).toBeCloseTo(0.004, 10); // 1000*$2/M + 200*$10/M

    const files = fs.readdirSync(fixturesDir);
    expect(files).toHaveLength(1);
    const cassette = JSON.parse(fs.readFileSync(path.join(fixturesDir, files[0] ?? ""), "utf8"));
    expect(Object.keys(cassette).sort()).toEqual(
      ["key", "model", "op", "recordedAt", "request", "response", "usage"].sort(),
    );
    expect(files[0]).toBe(`${cassette.key}.json`);
    expect(cassette.op).toBe("suggest");
    expect(cassette.model).toBe("claude-sonnet-5-5");

    const second = await client.call(input);
    expect(second.replayed).toBe(true);
    expect(second.costUsd).toBe(0);
    expect(second.output).toEqual(first.output);
    expect(transport).toHaveBeenCalledTimes(1);

    expect(readLedger(ledgerPath)).toHaveLength(1);
    expect(client.stats()).toMatchObject({ liveCalls: 1, replayedCalls: 1, failedCalls: 0 });
  });

  it("replay: a hit returns the recording without calling the transport", async () => {
    await createLlmClient({
      mode: "record",
      transport: fakeTransport(),
      fixturesDir,
      ledgerPath,
    }).call(input);
    const transport = fakeTransport();
    const result = await createLlmClient({
      mode: "replay",
      transport,
      fixturesDir,
      ledgerPath,
    }).call(input);
    expect(result.replayed).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });

  it("replay: a miss throws LlmUnavailable(no_recording) and spends nothing", async () => {
    const transport = fakeTransport();
    const client = createLlmClient({ mode: "replay", transport, fixturesDir, ledgerPath });
    await expect(client.call(input)).rejects.toMatchObject({
      name: "LlmUnavailable",
      reason: "no_recording",
    });
    expect(transport).not.toHaveBeenCalled();
    expect(readLedger(ledgerPath)).toEqual([]);
    expect(client.stats().failedCalls).toBe(1);
  });

  it("live: always calls and never writes a cassette", async () => {
    const transport = fakeTransport();
    const client = createLlmClient({ mode: "live", transport, fixturesDir, ledgerPath });
    await client.call(input);
    await client.call(input);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(fixturesDir)).toBe(false);
    expect(readLedger(ledgerPath)).toHaveLength(2);
  });

  it("record: with no API key the default transport throws LlmUnavailable(no_api_key)", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const client = createLlmClient({ mode: "record", fixturesDir, ledgerPath });
      const err = await client.call(input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmUnavailable);
      expect((err as LlmUnavailable).reason).toBe("no_api_key");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("rejects output that fails the schema, but still bills the tokens", async () => {
    const client = createLlmClient({
      mode: "record",
      transport: fakeTransport('{"nope":1}'),
      fixturesDir,
      ledgerPath,
    });
    await expect(client.call(input)).rejects.toMatchObject({ reason: "invalid_output" });
    expect(readLedger(ledgerPath)).toHaveLength(1);
    expect(fs.existsSync(fixturesDir)).toBe(false);
  });

  it("bills a refusal before reporting it, and records no cassette", async () => {
    const transport = vi.fn<LlmTransport>(async (req) => ({
      text: "",
      stopReason: "refusal",
      refusalCategory: "cyber",
      model: req.model,
      usage,
    }));
    const client = createLlmClient({ mode: "record", transport, fixturesDir, ledgerPath });
    await expect(client.call(input)).rejects.toMatchObject({ reason: "refusal" });
    expect(readLedger(ledgerPath)).toHaveLength(1);
    expect(fs.existsSync(fixturesDir)).toBe(false);
  });
});

describe("ledger", () => {
  const M = 1_000_000;
  const only = (k: "inputTokens" | "outputTokens" | "cacheReadTokens") => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    [k]: M,
  });

  it("prices claude-sonnet-5-5 at $2 in / $10 out / $0.10 cache read per 1M tokens", () => {
    const sonnet = "claude-sonnet-5-5";
    expect(costUsd(only("inputTokens"), sonnet)).toBe(2);
    expect(costUsd(only("outputTokens"), sonnet)).toBe(10);
    expect(costUsd(only("cacheReadTokens"), sonnet)).toBe(0.1);
    expect(costUsd(usage, sonnet)).toBeCloseTo(0.004, 10);
  });

  it("prices claude-haiku-5-5 at $0.10 in / $0.50 out / $0.01 cache read per 1M tokens", () => {
    const haiku = "claude-haiku-5-5";
    expect(costUsd(only("inputTokens"), haiku)).toBe(0.1);
    expect(costUsd(only("outputTokens"), haiku)).toBe(0.5);
    expect(costUsd(only("cacheReadTokens"), haiku)).toBe(0.01);
  });

  it("prices an unknown model as the dearest known one", () => {
    expect(costUsd(only("outputTokens"), "claude-unknown")).toBe(10);
  });

  it("appends JSONL entries and summarizes them", () => {
    const entry = {
      ts: "2026-11-16T00:00:00.000Z",
      op: "suggest",
      model: "claude-sonnet-5-5",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.004,
    };
    appendLedger(entry, ledgerPath);
    appendLedger({ ...entry, op: "expand", costUsd: 0.001 }, ledgerPath);
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual(entry);
    const summary = summarizeLedger(readLedger(ledgerPath));
    expect(summary.liveCalls).toBe(2);
    expect(summary.totalUsd).toBeCloseTo(0.005, 10);
  });

  it("reads a missing ledger as empty", () => {
    expect(readLedger(path.join(dir, "missing.jsonl"))).toEqual([]);
  });
});

describe("CassetteStore", () => {
  it("refuses keys that are not sha256 hex (no path traversal)", () => {
    expect(() => new CassetteStore(fixturesDir).read("../../etc/passwd")).toThrow();
  });
});
