/**
 * Wire types for the API, mirrored from api/src/domain/types.ts. They are mirrored rather than
 * imported because the web tsconfig only includes `src/`. Keep the two in step.
 */

export interface DocumentSummary {
  id: string;
  title: string;
  version: number;
  length: number;
}

export interface DocumentBody {
  id: string;
  title: string;
  text: string;
  version: number;
}

export interface SearchHit {
  docId: string;
  title: string;
  docVersion: number;
  start: number;
  end: number;
  snippet: string;
  /** Offsets relative to `snippet`. */
  highlights: { start: number; end: number }[];
  score: number;
  matchedTerms: string[];
  /** The document has moved past `docVersion` and is still being reindexed. */
  stale: boolean;
}

/** A document whose search index is behind its latest version. */
export interface SearchIndexing {
  docId: string;
  title: string;
  indexedVersion: number;
  currentVersion: number;
}

export interface SearchExpansion {
  status: "applied" | "skipped" | "off";
  added: string[];
  reason?: string;
}

export interface SearchResponse {
  query: string;
  terms: string[];
  phrases: string[];
  expansion: SearchExpansion;
  total: number;
  results: SearchHit[];
  /** Every matching document with its passage count, over all matches (not just this page). */
  documents: SearchDocumentCount[];
  /** Documents in scope still being reindexed; empty when every result is current. */
  indexing: SearchIndexing[];
}

export interface SearchDocumentCount {
  docId: string;
  title: string;
  passages: number;
}

export interface Segment {
  type: "equal" | "delete" | "insert";
  text: string;
}

export interface RedlineHunk {
  changeIndex: number;
  start: number;
  end: number;
  before: string;
  after: string;
  segments: Segment[];
}

/**
 * The UI targets the selection's [start, end) range (UTF-16 offsets) with `expectedText`, so a
 * stale selection fails with 422 instead of editing other text. (The API also accepts
 * `target: {text, occurrence?}`, which the UI does not use.)
 */
export interface ReplaceChange {
  operation: "replace";
  range: { start: number; end: number; expectedText?: string };
  replacement: string;
}

export interface PatchDocumentResponse {
  id: string;
  version: number;
  dryRun: boolean;
  text: string;
  redline: RedlineHunk[];
}

export interface SuggestionResponse {
  replacement: string;
  rationale: string;
  model: string;
}

export interface ErrorBody {
  error: string;
  code: number;
  details?: { reason: string } & Record<string, unknown>;
}

/** Longest range the suggestions route accepts (PASSAGE_MAX_CHARS in api/src/config.ts). */
export const PASSAGE_MAX_CHARS = 400;

/** Longest instruction the suggestions route accepts (`.max(1000)` in api/src/routes/suggestions.ts). */
export const INSTRUCTION_MAX_CHARS = 1000;
