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

export const LLM_MODEL = "claude-sonnet-5-5";
/** Read lazily so tests and the evals runner can override it per run. */
export function llmMode(): LlmMode {
  return parseLlmMode(process.env.LLM_MODE);
}

export const TIMEOUTS_MS = {
  expansion: 2500,
  suggestion: 20000,
} as const;

/** USD per 1M tokens for claude-sonnet-5-5. */
export const PRICES_PER_MTOK = {
  input: 2,
  output: 10,
  cacheRead: 0.1,
} as const;

/** Hard cap is enforced on the Claude platform; we track spend against it locally. */
export const PROJECT_BUDGET_USD = 30;

/** One spend ledger per project; the Makefile points it at the main checkout's data/. */
export const LLM_LEDGER_PATH: string | undefined = process.env.LLM_LEDGER_PATH || undefined;

/** Max chars of a passage sent for a suggestion. */
export const PASSAGE_MAX_CHARS = 400;

/** Max chars of surrounding text on each side of a redline hunk. */
export const REDLINE_CONTEXT_CHARS = 80;

/** Max changes in one PATCH. The engine handles any number of non-overlapping changes. */
export const MAX_CHANGES_PER_REQUEST = 1;

export const PATHS = {
  apiRoot: API_ROOT,
  repoRoot: REPO_ROOT,
  seedDir: path.join(API_ROOT, "seed"),
  fixturesDir: path.join(API_ROOT, "fixtures", "llm"),
  dataDir: process.env.DATA_DIR ?? path.join(REPO_ROOT, "data"),
} as const;

export function dataPath(...parts: string[]): string {
  return path.join(PATHS.dataDir, ...parts);
}
