import { z } from "zod";
import { notFound, notImplemented } from "../errors.js";
import { log } from "../log.js";
import { validate } from "../validation.js";
import type { DocumentStore } from "../domain/types.js";
import type { Registrar } from "./deps.js";

const CreateDocumentBody = z.object({
  title: z.string().trim().min(1).max(500),
  text: z.string().min(1),
});

const PatchDocumentBody = z.object({
  changes: z
    .array(
      z.object({
        operation: z.literal("replace"),
        target: z.object({
          text: z.string().min(1),
          occurrence: z.number().int().min(1).optional(),
        }),
        replacement: z.string(),
      }),
    )
    .min(1),
});

const PatchQuery = z.object({
  dryRun: z.enum(["true", "false"]).optional(),
});

export function requireDocument(store: DocumentStore, id: string) {
  const doc = store.get(id);
  if (!doc) throw notFound("DOCUMENT_NOT_FOUND", `Document ${id} not found`);
  return doc;
}

export const registerDocumentRoutes: Registrar = (app, { store }) => {
  app.get("/documents", (c) => c.json({ documents: store.list() }));

  app.get("/documents/:id", (c) => {
    const { id, title, text, version } = requireDocument(store, c.req.param("id"));
    return c.json({ id, title, text, version });
  });

  app.post("/documents", validate("json", CreateDocumentBody), (c) => {
    const body = c.req.valid("json");
    const doc = store.create(body);
    log.info("document.create", { docId: doc.id, length: doc.text.length });
    return c.json({ id: doc.id, title: doc.title, text: doc.text, version: doc.version }, 201);
  });

  // Stub: edits land in a later ticket. Response shape: PatchDocumentResponse.
  app.patch(
    "/documents/:id",
    validate("query", PatchQuery),
    validate("json", PatchDocumentBody),
    (c) => {
      requireDocument(store, c.req.param("id"));
      throw notImplemented("PATCH /documents/:id");
    },
  );

  // Stub: response shape ChangesResponse.
  app.get("/documents/:id/changes", (c) => {
    requireDocument(store, c.req.param("id"));
    throw notImplemented("GET /documents/:id/changes");
  });
};
