import { z } from "zod";
import { applyOps } from "../changes/apply.js";
import { buildRedline } from "../changes/redline.js";
import { resolveChanges } from "../changes/resolve.js";
import { MAX_CHANGES_PER_REQUEST } from "../config.js";
import { notFound } from "../errors.js";
import { log } from "../log.js";
import { validate } from "../validation.js";
import type { ChangeOp, DocumentStore, PatchDocumentResponse } from "../domain/types.js";
import type { Registrar } from "./deps.js";
import { checkIfMatch, etagFor } from "./etag.js";

const CreateDocumentBody = z.object({
  title: z.string().trim().min(1).max(500),
  text: z.string().min(1),
});

// Exactly one of `target` or `range`: each branch forbids the other's key.
const TargetChange = z.object({
  operation: z.literal("replace"),
  target: z.object({
    text: z.string().min(1),
    occurrence: z.number().int().min(1).optional(),
  }),
  range: z.never().optional(),
  replacement: z.string(),
});

// Bounds are checked against the document (422 RANGE_OUT_OF_BOUNDS), not here.
const RangeChange = z.object({
  operation: z.literal("replace"),
  range: z.object({
    start: z.number().int(),
    end: z.number().int(),
    expectedText: z.string().optional(),
  }),
  target: z.never().optional(),
  replacement: z.string(),
});

const PatchDocumentBody = z.object({
  changes: z
    .array(z.union([TargetChange, RangeChange]))
    .min(1)
    .max(MAX_CHANGES_PER_REQUEST),
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
    c.header("ETag", etagFor(version));
    return c.json({ id, title, text, version });
  });

  app.post("/documents", validate("json", CreateDocumentBody), (c) => {
    const body = c.req.valid("json");
    const doc = store.create(body);
    log.info("document.create", { docId: doc.id, length: doc.text.length });
    return c.json({ id: doc.id, title: doc.title, text: doc.text, version: doc.version }, 201);
  });

  // Synchronous from read to commit, so no other request can interleave.
  app.patch(
    "/documents/:id",
    validate("query", PatchQuery),
    validate("json", PatchDocumentBody),
    (c) => {
      const started = performance.now();
      const doc = requireDocument(store, c.req.param("id"));
      const { changes } = c.req.valid("json");
      const dryRun = c.req.valid("query").dryRun === "true";
      checkIfMatch(c.req.header("If-Match"), doc.version);

      const resolved = resolveChanges(doc.text, changes);
      const ops: ChangeOp[] = resolved.map(({ start, end, oldText, newText }) => ({
        start,
        end,
        oldText,
        newText,
      }));
      const text = applyOps(doc.text, ops);
      const redline = buildRedline(doc.text, resolved);
      const version = dryRun ? doc.version : store.commit(doc.id, text, ops).version;

      log.info("doc.patched", {
        docId: doc.id,
        version,
        changes: changes.length,
        dryRun,
        ms: Math.round((performance.now() - started) * 10) / 10,
      });
      const body: PatchDocumentResponse = { id: doc.id, version, dryRun, text, redline };
      c.header("ETag", etagFor(version));
      return c.json(body);
    },
  );
};
