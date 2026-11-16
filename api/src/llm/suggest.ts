/**
 * Edit suggestions: the model drafts replacement text for one selected passage. It supplies
 * text only; the span it replaces always comes from the caller's range (D12).
 */
import { z } from "zod";
import { SUGGESTION_MODEL, TIMEOUTS_MS } from "../config.js";
import type { SuggestionInput, SuggestionResult } from "../domain/types.js";
import type { LlmClient } from "./client.js";

export const SUGGESTION_SYSTEM = `You are a contract drafting assistant inside a legal redlining tool.
You receive a selected passage from a contract, some surrounding text for context, and optionally an instruction from the lawyer.
Return replacement text for the selected passage only, plus a one-line rationale.
Rules:
- "replacement" must replace exactly the selected passage: do not include any of the surrounding context, and do not add new clauses beyond what the instruction requires.
- Change only what the instruction asks. If there is no instruction, make a minimal edit that improves clarity and precision without changing the commercial or legal effect.
- Keep every defined term exactly as written, including capitalization (e.g. "Confidential Information", "Company", "Customer"), unless the instruction says otherwise. Do not introduce new defined terms unless the instruction requires it.
- Keep clause numbering (e.g. a leading "6.2"), cross-references and numerals-with-words formats (e.g. "thirty (30) days") exactly as in the original, unless the instruction says otherwise.
- Keep every qualifier and limiting word of the original (e.g. "invoiced", "undisputed", "reasonable", "material", "solely") unless the instruction says otherwise.
- Match the drafting style and tense of the original. Do not wrap the replacement in quotation marks.
- "rationale" is one short sentence describing what changed and why.`;

export const SuggestionSchema = z.object({
  replacement: z.string(),
  rationale: z.string(),
});

const SUGGESTION_MAX_TOKENS = 1024;

export function suggestionMessage(input: SuggestionInput): string {
  return [
    `<context_before>${input.contextBefore ?? ""}</context_before>`,
    `<selected_passage>${input.text}</selected_passage>`,
    `<context_after>${input.contextAfter ?? ""}</context_after>`,
    `<instruction>${input.instruction ?? "(none - improve clarity only)"}</instruction>`,
  ].join("\n");
}

const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ["“", "”"],
  ["'", "'"],
  ["‘", "’"],
];

/**
 * Strips quotation marks the model wrapped around the whole replacement (but not ones the
 * original passage had), and restores the original's leading and trailing whitespace, so the
 * replacement drops into the same span without merging into its neighbours.
 */
export function normalizeReplacement(original: string, replacement: string): string {
  let body = replacement.trim();
  const orig = original.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (body.length < 2 || !body.startsWith(open) || !body.endsWith(close)) continue;
    const inner = body.slice(open.length, body.length - close.length);
    // Only a pair that wraps the whole text and that the original did not open with.
    if (orig.startsWith(open) || inner.includes(open) || inner.includes(close)) continue;
    body = inner.trim();
    break;
  }
  const lead = /^\s*/.exec(original)?.[0] ?? "";
  const trail = orig === "" ? "" : (/\s*$/.exec(original)?.[0] ?? "");
  return lead + body + trail;
}

export type SuggestFn = (input: SuggestionInput) => Promise<SuggestionResult>;

/** Errors (LlmUnavailable and others) propagate; the route maps them to HTTP statuses. */
export function createSuggester(client: LlmClient, opts: { model?: string } = {}): SuggestFn {
  const model = opts.model ?? SUGGESTION_MODEL;
  return async (input) => {
    const { output } = await client.call({
      op: "suggest",
      model,
      system: SUGGESTION_SYSTEM,
      messages: [{ role: "user", content: suggestionMessage(input) }],
      schema: SuggestionSchema,
      maxTokens: SUGGESTION_MAX_TOKENS,
      effort: "low",
      timeoutMs: TIMEOUTS_MS.suggestion,
    });
    return {
      replacement: normalizeReplacement(input.text, output.replacement),
      rationale: output.rationale.replace(/\s+/g, " ").trim(),
      model,
    };
  };
}
