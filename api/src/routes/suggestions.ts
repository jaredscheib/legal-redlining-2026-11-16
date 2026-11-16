import { z } from "zod";
import { PASSAGE_MAX_CHARS } from "../config.js";
import { ApiError, notImplemented } from "../errors.js";
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

export const registerSuggestionRoutes: Registrar = (app, { store, llm }) => {
  app.post("/documents/:id/suggestions", validate("json", SuggestionBody), async (c) => {
    const doc = requireDocument(store, c.req.param("id"));
    const { range, instruction } = c.req.valid("json");
    if (range.end > doc.text.length) {
      throw new ApiError(400, "RANGE_OUT_OF_BOUNDS", "range is outside the document", {
        length: doc.text.length,
      });
    }
    if (!llm) throw notImplemented("POST /documents/:id/suggestions");
    const result = await llm.suggest({ text: doc.text.slice(range.start, range.end), instruction });
    return c.json(result);
  });
};
