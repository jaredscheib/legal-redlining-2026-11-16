import { z } from "zod";
import { validate } from "../validation.js";
import type { Registrar } from "./deps.js";

const toArray = (v: string | string[] | undefined) =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  docId: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  offset: z.coerce.number().int().min(0).default(0),
  expand: z.enum(["true", "false"]).default("true"),
});

export const registerSearchRoutes: Registrar = (app, { search }) => {
  app.get("/search", validate("query", SearchQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const result = await search.search({
      q: query.q,
      docIds: toArray(query.docId),
      limit: query.limit,
      offset: query.offset,
      expand: query.expand === "true",
    });
    return c.json(result);
  });
};
