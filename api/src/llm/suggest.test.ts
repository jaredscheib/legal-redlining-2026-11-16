import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmClient } from "./client.js";
import { createSuggester, normalizeReplacement, suggestionMessage } from "./suggest.js";
import type { LlmTransport } from "./types.js";

describe("normalizeReplacement", () => {
  it("strips quotes the model wrapped around the replacement", () => {
    expect(normalizeReplacement("Customer may cancel.", '"Customer may terminate."')).toBe(
      "Customer may terminate.",
    );
    expect(normalizeReplacement("Customer may cancel.", "“Customer may end.”")).toBe(
      "Customer may end.",
    );
    expect(normalizeReplacement("x", "'y'")).toBe("y");
  });

  it("keeps quotes the original passage had, and quoted terms at both ends", () => {
    expect(normalizeReplacement('"Fees" means "Charges"', '"Fees" means all "Charges"')).toBe(
      '"Fees" means all "Charges"',
    );
    expect(normalizeReplacement("Fees means Charges", '"Fees" means "Charges"')).toBe(
      '"Fees" means "Charges"',
    );
  });

  it("keeps inner quotes and an unbalanced quote", () => {
    expect(normalizeReplacement("a", '"Fees" means fees')).toBe('"Fees" means fees');
  });

  it("restores the original's leading and trailing whitespace", () => {
    expect(normalizeReplacement("\n  6.2 Fees are due.  \n", "6.2 Fees are payable.\n")).toBe(
      "\n  6.2 Fees are payable.  \n",
    );
    expect(normalizeReplacement("Fees are due.", "  Fees are payable. ")).toBe("Fees are payable.");
  });
});

describe("suggestionMessage", () => {
  it("wraps the passage, context and instruction in tags", () => {
    expect(
      suggestionMessage({ text: "P", contextBefore: "B", contextAfter: "A", instruction: "I" }),
    ).toBe(
      [
        "<context_before>B</context_before>",
        "<selected_passage>P</selected_passage>",
        "<context_after>A</context_after>",
        "<instruction>I</instruction>",
      ].join("\n"),
    );
    expect(suggestionMessage({ text: "P" })).toContain("<instruction>(none - improve clarity");
  });
});

describe("createSuggester", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suggest-test-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("calls the suggestion model at effort low and normalizes its answer", async () => {
    const transport = vi.fn<LlmTransport>(async (req) => ({
      text: JSON.stringify({
        replacement: '"6.2 Customer will pay all Fees invoiced within sixty (60) days."',
        rationale: "Extends the payment window\nas instructed.",
      }),
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
    const res = await createSuggester(client)({
      text: "6.2 Customer will pay all Fees invoiced within thirty (30) days. ",
      instruction: "sixty days",
    });
    expect(res).toEqual({
      replacement: "6.2 Customer will pay all Fees invoiced within sixty (60) days. ",
      rationale: "Extends the payment window as instructed.",
      model: "claude-sonnet-5-5",
    });
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "low",
      maxTokens: 1024,
    });
    expect(transport.mock.calls[0]?.[0].thinking).toBeUndefined();
  });
});
