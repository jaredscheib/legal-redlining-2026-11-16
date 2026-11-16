/**
 * Wire types for the API, mirrored from api/src/domain/types.ts. They are mirrored rather than
 * imported because the web tsconfig only includes `src/`, and the search hit on the wire carries
 * `matchedTerms`, which the domain type does not declare yet.
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

export interface ReplaceChange {
  operation: "replace";
  target: { text: string; occurrence?: number };
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
