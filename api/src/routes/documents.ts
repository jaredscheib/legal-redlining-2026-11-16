import { z } from "zod";
import { applyOps } from "../changes/apply.js";
import { buildRedline } from "../changes/redline.js";
import { resolveChanges } from "../changes/resolve.js";
import { MAX_CHANGES_PER_REQUEST } from "../config.js";
import { notFound } from "../errors.js";
import { elapsedMs, log } from "../log.js";
import { validate } from "../validation.js";
import type {
  ChangeOp,
  DocumentStore,
  PatchDocumentResponse,
  ReplaceChange,
} from "../domain/types.js";
import type { Registrar } from "./deps.js";
import { checkIfMatch, etagFor } from "./etag.js";

// Every request schema is strict: an unknown key (say a misspelled `occurence`) is a 400, never
// silently dropped.
const CreateDocumentBody = z.strictObject({
  title: z.string().trim().min(1).max(500),
  text: z.string().min(1),
});

const Target = z.strictObject({
  text: z.string().min(1),
  occurrence: z.number().int().min(1).optional(),
});

// Bounds are checked against the document (422 RANGE_OUT_OF_BOUNDS), not here.
const Range = z.strictObject({
  start: z.number().int(),
  end: z.number().int(),
  expectedText: z.string().optional(),
});

// One object rather than a union of the two forms, so a bad key or value inside either form
// is reported at its own path instead of as "matches no branch".
const Change = z
  .strictObject({
    operation: z.literal("replace"),
    target: Target.optional(),
    range: Range.optional(),
    replacement: z.string(),
  })
  .refine((c) => (c.target === undefined) !== (c.range === undefined), {
    message: 'must have exactly one of "target" or "range"',
  })
  .transform((c) => c as ReplaceChange);

const PatchDocumentBody = z.strictObject({
  changes: z.array(Change).min(1).max(MAX_CHANGES_PER_REQUEST),
});

const PatchQuery = z.strictObject({
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
    // The body first, so an unsupported media type is a 415 before anything else.
    validate("json", PatchDocumentBody),
    validate("query", PatchQuery),
    (c) => {
      const started = performance.now();
      const doc = requireDocument(store, c.req.param("id"));
      const { changes } = c.req.valid("json");
      const dryRun = c.req.valid("query").dryRun === "true";
      checkIfMatch(c.req.header("If-Match"), doc.version);

      const resolved = resolveChanges(doc.text, changes);
      // Applied with their changeIndex, so an overlap names the colliding changes.
      const text = applyOps(doc.text, resolved);
      const ops: ChangeOp[] = resolved.map(({ start, end, oldText, newText }) => ({
        start,
        end,
        oldText,
        newText,
      }));
      const redline = buildRedline(doc.text, resolved);
      const version = dryRun ? doc.version : store.commit(doc.id, text, ops).version;

      log.info("doc.patched", {
        docId: doc.id,
        version,
        changes: changes.length,
        dryRun,
        ms: elapsedMs(started),
      });
      const body: PatchDocumentResponse = { id: doc.id, version, dryRun, text, redline };
      c.header("ETag", etagFor(version));
      return c.json(body);
    },
  );
};
