/**
 * The deployed mode: replay first, live up to a cap, and a read-only filesystem that must not
 * fail a call. Everything here is a fake; nothing touches the network or the disk.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { log } from "../log.js";
import { llmMaxLiveCalls } from "../config.js";
import { createLlmClient } from "./client.js";
import type { appendLedger } from "./ledger.js";
import type { Cassette } from "./replay.js";
import { LlmUnavailable, type LlmTransport } from "./types.js";

const Out = z.object({ replacement: z.string(), rationale: z.string() });

const input = (content: string) => ({
  op: "suggest",
  model: "claude-sonnet-5-5",
  system: "You redline contracts.",
  messages: [{ role: "user" as const, content }],
  schema: Out,
  maxTokens: 256,
  effort: "low" as const,
  timeoutMs: 1000,
});

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

function fakeTransport() {
  return vi.fn<LlmTransport>(async (req) => ({
    text: '{"replacement":"r","rationale":"x"}',
    stopReason: "end_turn",
    model: req.model,
    usage,
  }));
}

function memoryCassettes() {
  const saved = new Map<string, Cassette>();
  return {
    saved,
    read: (key: string) => saved.get(key),
    write: (c: Cassette) => void saved.set(c.key, c),
  };
}

const erofs = () => Object.assign(new Error("read-only file system"), { code: "EROFS" });
const okLedger = vi.fn<typeof appendLedger>();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("LLM_MAX_LIVE_CALLS", () => {
  it("defaults to 200 when unset, is overridden by the env var, and rejects junk", () => {
    vi.stubEnv("LLM_MAX_LIVE_CALLS", undefined);
    expect(llmMaxLiveCalls()).toBe(200);
    vi.stubEnv("LLM_MAX_LIVE_CALLS", "");
    expect(llmMaxLiveCalls()).toBe(200);
    vi.stubEnv("LLM_MAX_LIVE_CALLS", "5");
    expect(llmMaxLiveCalls()).toBe(5);
    vi.stubEnv("LLM_MAX_LIVE_CALLS", "0");
    expect(llmMaxLiveCalls()).toBe(0);
    vi.stubEnv("LLM_MAX_LIVE_CALLS", "-1");
    expect(() => llmMaxLiveCalls()).toThrow();
    vi.stubEnv("LLM_MAX_LIVE_CALLS", "lots");
    expect(() => llmMaxLiveCalls()).toThrow();
  });

  it("refuses with cap_reached after the cap, without calling the API", async () => {
    const transport = fakeTransport();
    const client = createLlmClient({
      mode: "record",
      transport,
      cassettes: memoryCassettes(),
      appendLedger: okLedger,
      maxLiveCalls: 2,
    });
    await client.call(input("a"));
    await client.call(input("b"));
    const err = await client.call(input("c")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailable);
    expect((err as LlmUnavailable).reason).toBe("cap_reached");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(client.stats().liveCalls).toBe(2);
  });

  it("still serves recordings once the cap is reached", async () => {
    const transport = fakeTransport();
    const cassettes = memoryCassettes();
    const client = createLlmClient({
      mode: "record",
      transport,
      cassettes,
      appendLedger: okLedger,
      maxLiveCalls: 1,
    });
    await client.call(input("a"));
    const again = await client.call(input("a"));
    expect(again.replayed).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("counts a failed live call against the cap (it may still be billed)", async () => {
    const transport = vi.fn<LlmTransport>(async () => {
      throw new LlmUnavailable("timeout");
    });
    const client = createLlmClient({
      mode: "live",
      transport,
      cassettes: memoryCassettes(),
      appendLedger: okLedger,
      maxLiveCalls: 1,
    });
    await expect(client.call(input("a"))).rejects.toMatchObject({ reason: "timeout" });
    await expect(client.call(input("a"))).rejects.toMatchObject({ reason: "cap_reached" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("read-only filesystem", () => {
  it("a cassette that cannot be written logs a warning and the call succeeds", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const client = createLlmClient({
      mode: "record",
      transport: fakeTransport(),
      cassettes: {
        read: () => undefined,
        write: () => {
          throw erofs();
        },
      },
      appendLedger: okLedger,
    });
    const result = await client.call(input("a"));
    expect(result.output.replacement).toBe("r");
    expect(warn).toHaveBeenCalledWith(
      "llm.cassette_unwritable",
      expect.objectContaining({ code: "EROFS" }),
    );
  });

  it("a ledger that cannot be written logs llm.ledger_unwritable once and calls succeed", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const ledger = vi.fn<typeof appendLedger>(() => {
      throw erofs();
    });
    const client = createLlmClient({
      mode: "live",
      transport: fakeTransport(),
      cassettes: memoryCassettes(),
      appendLedger: ledger,
    });
    await client.call(input("a"));
    await client.call(input("b"));
    expect(ledger).toHaveBeenCalledTimes(2);
    const ledgerWarnings = warn.mock.calls.filter(([event]) => event === "llm.ledger_unwritable");
    expect(ledgerWarnings).toHaveLength(1);
    expect(client.stats().liveCalls).toBe(2);
  });
});
