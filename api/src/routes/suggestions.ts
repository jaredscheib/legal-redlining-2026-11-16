import { z } from "zod";
import { PASSAGE_MAX_CHARS, SUGGESTION_CONTEXT_CHARS } from "../config.js";
import { ApiError } from "../errors.js";
import { LlmUnavailable } from "../llm/types.js";
import { validate } from "../validation.js";
import { requireDocument } from "./documents.js";
import type { Registrar } from "./deps.js";

const SuggestionBody = z.object({
  range: z
    .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
    .refine((r) => r.end > r.start, { message: "end must be greater than start" })
    .refine((r) => r.end - r.start <= PASSAGE_MAX_CHARS, {
      message: `range must be at most ${PASSAGE_MAX_CHARS} characters`,
    }),
  instruction: z.string().trim().min(1).max(1000).optional(),
});

/** The passage and up to SUGGESTION_CONTEXT_CHARS of text on each side, clipped at the edges. */
export function sliceForSuggestion(text: string, range: { start: number; end: number }) {
  return {
    text: text.slice(range.start, range.end),
    contextBefore: text.slice(Math.max(0, range.start - SUGGESTION_CONTEXT_CHARS), range.start),
    contextAfter: text.slice(range.end, range.end + SUGGESTION_CONTEXT_CHARS),
  };
}

/**
 * The model could not be reached (no key, timeout, no recording, API error): 503.
 * It answered but gave nothing usable (refusal, invalid output): 502.
 */
export function llmError(err: LlmUnavailable): ApiError {
  const details = { llmReason: err.reason };
  if (err.reason === "refusal" || err.reason === "invalid_output") {
    return new ApiError(502, "LLM_ERROR", "The model returned no usable suggestion", details);
  }
  return new ApiError(503, "LLM_UNAVAILABLE", "The suggestion model is unavailable", details);
}

export const registerSuggestionRoutes: Registrar = (app, { store, llm }) => {
  app.post("/documents/:id/suggestions", validate("json", SuggestionBody), async (c) => {
    const doc = requireDocument(store, c.req.param("id"));
    const { range, instruction } = c.req.valid("json");
    if (range.end > doc.text.length) {
      throw new ApiError(422, "RANGE_OUT_OF_BOUNDS", "range is outside the document", {
        length: doc.text.length,
      });
    }
    try {
      const result = await llm.suggest({ ...sliceForSuggestion(doc.text, range), instruction });
      return c.json(result);
    } catch (err) {
      if (err instanceof LlmUnavailable) throw llmError(err);
      throw err;
    }
  });
};
