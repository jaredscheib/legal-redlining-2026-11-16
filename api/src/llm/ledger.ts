/**
 * Spend ledger: one JSONL line per live (non-replayed) call in data/llm-ledger.jsonl.
 * The $30 project cap itself is enforced on the Claude platform; this is our record against it.
 */
import fs from "node:fs";
import path from "node:path";
import { LLM_LEDGER_PATH, PRICES_PER_MTOK, dataPath, type ModelPrices } from "../config.js";
import type { LlmUsage } from "./types.js";

export interface LedgerEntry {
  ts: string;
  op: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/**
 * LLM_LEDGER_PATH (set by the Makefile to the main checkout's data/) keeps one ledger for the
 * whole project, so spend recorded in a builder's worktree is not lost with the worktree.
 */
export const defaultLedgerPath = () => LLM_LEDGER_PATH ?? dataPath("llm-ledger.jsonl");

/** Cache writes (5-minute TTL) bill at 1.25x the input price. */
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Prices for `model`; an unknown model is priced as the dearest known one, never as free. */
export function pricesFor(model: string): ModelPrices {
  const known = PRICES_PER_MTOK[model];
  if (known) return known;
  return Object.values(PRICES_PER_MTOK).reduce((a, b) => (b.output > a.output ? b : a));
}

export function costUsd(usage: LlmUsage, model: string): number {
  const prices = pricesFor(model);
  const usd =
    (usage.inputTokens * prices.input +
      usage.outputTokens * prices.output +
      usage.cacheReadTokens * prices.cacheRead +
      usage.cacheWriteTokens * prices.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000;
  return Math.round(usd * 1e8) / 1e8;
}

export function appendLedger(entry: LedgerEntry, file: string = defaultLedgerPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

export function readLedger(file: string = defaultLedgerPath()): LedgerEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LedgerEntry);
}

export interface SpendSummary {
  liveCalls: number;
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export function summarizeLedger(entries: LedgerEntry[]): SpendSummary {
  return entries.reduce<SpendSummary>(
    (acc, e) => ({
      liveCalls: acc.liveCalls + 1,
      totalUsd: acc.totalUsd + e.costUsd,
      inputTokens: acc.inputTokens + e.inputTokens,
      outputTokens: acc.outputTokens + e.outputTokens,
    }),
    { liveCalls: 0, totalUsd: 0, inputTokens: 0, outputTokens: 0 },
  );
}
