/** Domain model and service contracts. Offsets are UTF-16 code-unit indexes into `text`. */

export interface Document {
  id: string;
  title: string;
  text: string;
  /** Starts at 1; each commit bumps it by one. */
  version: number;
}

export interface DocumentSummary {
  id: string;
  title: string;
  version: number;
  length: number;
}

/** One replacement over [start, end) of the text it was computed against. */
export interface ChangeOp {
  start: number;
  end: number;
  oldText: string;
  newText: string;
}

export interface ChangeLogEntry {
  /** The version this commit produced. */
  version: number;
  appliedAt: string;
  ops: ChangeOp[];
}

export interface Segment {
  type: "equal" | "delete" | "insert";
  text: string;
}

export interface RedlineHunk {
  /** Index into the request's `changes` array. */
  changeIndex: number;
  start: number;
  end: number;
  before: string;
  after: string;
  segments: Segment[];
}

/** Fired after `create` (version 1, no ops) and after every `commit`. */
export type ChangeListener = (event: {
  kind: "create" | "commit";
  id: string;
  version: number;
  ops: ChangeOp[];
}) => void;

export interface DocumentStore {
  list(): DocumentSummary[];
  get(id: string): Document | undefined;
  create(input: { title: string; text: string; id?: string }): Document;
  /** Replaces the text, bumps the version and appends to the history. Throws if `id` is unknown. */
  commit(id: string, newText: string, ops: ChangeOp[]): Document;
  history(id: string): ChangeLogEntry[] | undefined;
  /** Returns an unsubscribe function. */
  onChange(listener: ChangeListener): () => void;
}

// ---------------------------------------------------------------- Search (future)

export interface SearchQuery {
  q: string;
  docIds?: string[];
  limit: number;
  offset: number;
  expand: boolean;
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
  /** Query and expansion terms (lowercased) that occur in this passage. */
  matchedTerms: string[];
  score: number;
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
  /**
   * Every matching document with its passage count, over all matches (not just this page),
   * sorted by passages descending, then by the document's best score.
   */
  documents: SearchDocumentCount[];
}

export interface SearchDocumentCount {
  docId: string;
  title: string;
  passages: number;
}

export interface SearchService {
  search(query: SearchQuery): Promise<SearchResponse>;
}

// ---------------------------------------------------------------- LLM (future)

export interface ExpansionResult {
  added: string[];
}

export interface SuggestionInput {
  text: string;
  instruction?: string;
}

export interface SuggestionResult {
  replacement: string;
  rationale: string;
  model: string;
}

export interface LlmService {
  expand(terms: string[]): Promise<ExpansionResult>;
  suggest(input: SuggestionInput): Promise<SuggestionResult>;
}

// ---------------------------------------------------------------- Edits

/** Replaces the `occurrence`-th (1-based, default 1) exact match of `target.text`. */
export interface ReplaceTargetChange {
  operation: "replace";
  target: { text: string; occurrence?: number };
  range?: never;
  replacement: string;
}

/**
 * Replaces [start, end) of the text (UTF-16 code units, half-open). If `expectedText` is
 * given it must equal the text at that range.
 */
export interface ReplaceRangeChange {
  operation: "replace";
  range: { start: number; end: number; expectedText?: string };
  target?: never;
  replacement: string;
}

/** Exactly one of `target` or `range`. */
export type ReplaceChange = ReplaceTargetChange | ReplaceRangeChange;

export interface PatchDocumentRequest {
  changes: ReplaceChange[];
}

export interface PatchDocumentResponse {
  id: string;
  version: number;
  dryRun: boolean;
  text: string;
  redline: RedlineHunk[];
}

export interface SuggestionRequest {
  range: { start: number; end: number };
  instruction?: string;
}

export type SuggestionResponse = SuggestionResult;
