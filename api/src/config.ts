/**
 * The one home for every tunable. Read env here and nowhere else.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** api/ — works from both src/ (tsx, vitest) and dist/ (node). */
const API_ROOT = path.resolve(here, "..");
const REPO_ROOT = path.resolve(API_ROOT, "..");

export type LlmMode = "record" | "replay" | "live";
const LLM_MODES: readonly LlmMode[] = ["record", "replay", "live"];

function parseLlmMode(raw: string | undefined): LlmMode {
  if (raw === undefined || raw === "") return "record";
  if ((LLM_MODES as readonly string[]).includes(raw)) return raw as LlmMode;
  throw new Error(`LLM_MODE must be one of ${LLM_MODES.join("|")}`);
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error("PORT must be 0-65535");
  return n;
}

export const PORT = parsePort(process.env.PORT, 8787);

/** Query expansion is short and latency-bound: the fast model. */
export const EXPANSION_MODEL = "claude-haiku-5-5";
/** Drafting a replacement clause: the stronger model. */
export const SUGGESTION_MODEL = "claude-sonnet-5-5";

/** Read lazily so tests and the evals runner can override it per run. */
export function llmMode(): LlmMode {
  return parseLlmMode(process.env.LLM_MODE);
}

/**
 * Live (billed) calls one process may make before the client refuses with `cap_reached`.
 * Unset means unlimited. Read lazily, like llmMode().
 */
export function llmMaxLiveCalls(): number {
  const raw = process.env.LLM_MAX_LIVE_CALLS;
  if (raw === undefined || raw === "") return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error("LLM_MAX_LIVE_CALLS must be an integer >= 0");
  return n;
}

export const TIMEOUTS_MS = {
  expansion: 2500,
  suggestion: 20000,
} as const;

export interface ModelPrices {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * USD per 1M tokens. Cache reads are 0.1x input. Haiku's rate is for prompts of 100K tokens
 * or fewer, which every call here is.
 */
export const PRICES_PER_MTOK: Readonly<Record<string, ModelPrices>> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
};

/** Expansion: alternatives kept per query term or phrase, and in total. */
export const EXPANSION_MAX_PER_TERM = 3;
export const EXPANSION_MAX_TOTAL = 9;
/** Entries in the in-memory expansion cache (LRU, keyed by the normalized term list). */
export const EXPANSION_CACHE_SIZE = 500;

/** Max chars of document text sent on each side of a passage for a suggestion. */
export const SUGGESTION_CONTEXT_CHARS = 200;

/** Hard cap is enforced on the Claude platform; we track spend against it locally. */
export const PROJECT_BUDGET_USD = 30;

/** One spend ledger per project; the Makefile points it at the main checkout's data/. */
export const LLM_LEDGER_PATH: string | undefined = process.env.LLM_LEDGER_PATH || undefined;

/** Max chars of a passage sent for a suggestion; also the longest search passage. */
export const PASSAGE_MAX_CHARS = 400;

/** Max chars of surrounding text on each side of a redline hunk. */
export const REDLINE_CONTEXT_CHARS = 80;

/** Max changes in one PATCH. The engine handles any number of non-overlapping changes. */
export const MAX_CHANGES_PER_REQUEST = 1;

/** BM25 parameters for passage search. */
export const BM25 = { k1: 1.2, b: 0.75 } as const;

/** BM25 weight of each term a query expansion adds (query terms weigh 1). */
export const EXPANSION_TERM_WEIGHT = 0.5;

export const PATHS = {
  apiRoot: API_ROOT,
  repoRoot: REPO_ROOT,
  /** SEED_DIR and FIXTURES_DIR let a bundled build (e.g. the Vercel function) carry its own. */
  seedDir: process.env.SEED_DIR || path.join(API_ROOT, "seed"),
  fixturesDir: process.env.FIXTURES_DIR || path.join(API_ROOT, "fixtures", "llm"),
  dataDir: process.env.DATA_DIR ?? path.join(REPO_ROOT, "data"),
} as const;

export function dataPath(...parts: string[]): string {
  return path.join(PATHS.dataDir, ...parts);
}
