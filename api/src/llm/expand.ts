/**
 * Query expansion: the unquoted key terms of a search go to the model, which groups adjacent
 * terms into legal phrases where that is meaningful and returns contract-language alternatives
 * for each term or phrase. We cap, dedupe and cache in code; the API does not enforce array
 * lengths in a JSON schema.
 */
import { z } from "zod";
import {
  EXPANSION_CACHE_SIZE,
  EXPANSION_MAX_PER_TERM,
  EXPANSION_MAX_TOTAL,
  EXPANSION_MODEL,
  TIMEOUTS_MS,
} from "../config.js";
import type { LlmService } from "../domain/types.js";
import { terms as tokenTerms } from "../search/tokenize.js";
import type { LlmClient } from "./client.js";
import { LlmUnavailable, type Thinking } from "./types.js";

export const EXPANSION_SYSTEM = `You expand search terms for a contract search engine used by lawyers.
You receive the key terms of one search, in the order the user typed them.
First, group adjacent terms that together name one legal concept into a phrase (e.g. ["confidential", "information"] -> "confidential information"; ["security", "deposit"] -> "security deposit"). Leave a term on its own when it is not part of such a phrase. Expand a phrase as a whole, not its words separately.
Then, for each term or phrase, return up to 3 alternatives that are likely to appear verbatim in contract text (e.g. terminate -> cancel, rescind, end; confidential information -> proprietary information, trade secrets).
Rules:
- Prefer words and short phrases drafters actually use in agreements; match the part of speech where possible.
- The search matches exact words with no stemming, so write each alternative in the form contracts most often use (e.g. singular nouns: "employee", not "employees").
- Do not repeat the term itself or simple inflections of it (terminate/terminated/termination).
- Do not include broader concepts or explanations; if a term or phrase has no good equivalents, return an empty list for it.
- "term" is the single term or the grouped phrase, written with the input words in order.`;

export const ExpansionSchema = z.object({
  expansions: z.array(
    z.object({
      term: z.string(),
      alternatives: z.array(z.string()),
    }),
  ),
});
export type ExpansionOutput = z.infer<typeof ExpansionSchema>;

export type ExpandFn = LlmService["expand"];

export interface ExpanderOptions {
  model?: string;
  thinking?: Thinking;
  timeoutMs?: number;
}

/**
 * Expansion runs with thinking off: on Haiku 5.5 at effort low it is no slower than adaptive
 * thinking, gives the same synonyms, and cannot spend the 200-token cap on thinking and return
 * no usable output. `make compare-expansion` measures both.
 */
export const EXPANSION_THINKING: Thinking | undefined = "disabled";
const EXPANSION_MAX_TOKENS = 200;

const QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g;

const normalize = (s: string) => s.toLowerCase().replace(QUOTES, "").replace(/\s+/g, " ").trim();

/**
 * Flatten, lowercase and dedupe the alternatives; drop any whose words are all already in the
 * query; keep at most EXPANSION_MAX_PER_TERM per term or phrase and EXPANSION_MAX_TOTAL overall.
 * Multi-word alternatives stay whole: the search service scores their words and highlights
 * the phrase.
 */
export function selectAlternatives(queryTerms: string[], output: ExpansionOutput): string[] {
  const inQuery = new Set(queryTerms.map(normalize));
  const added: string[] = [];
  for (const group of output.expansions) {
    let kept = 0;
    for (const raw of group.alternatives) {
      if (kept >= EXPANSION_MAX_PER_TERM || added.length >= EXPANSION_MAX_TOTAL) break;
      const alt = normalize(raw);
      const words = tokenTerms(alt);
      if (words.length === 0 || added.includes(alt)) continue;
      if (words.every((w) => inQuery.has(w))) continue;
      added.push(alt);
      kept++;
    }
  }
  return added;
}

export const cacheKey = (terms: string[]) => JSON.stringify(terms.map(normalize));

/** A Map in insertion order is an LRU: re-insert on hit, evict the first key when full. */
export class LruCache<V> {
  private readonly map = new Map<string, V>();
  constructor(readonly capacity: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

export function createExpander(client: LlmClient, opts: ExpanderOptions = {}): ExpandFn {
  const model = opts.model ?? EXPANSION_MODEL;
  const thinking = "thinking" in opts ? opts.thinking : EXPANSION_THINKING;
  const cache = new LruCache<string[]>(EXPANSION_CACHE_SIZE);

  return async (terms) => {
    const key = cacheKey(terms);
    const hit = cache.get(key);
    if (hit) return { added: [...hit] };
    try {
      const { output } = await client.call({
        op: "expand",
        model,
        system: EXPANSION_SYSTEM,
        messages: [{ role: "user", content: `Terms: ${JSON.stringify(terms)}` }],
        schema: ExpansionSchema,
        maxTokens: EXPANSION_MAX_TOKENS,
        effort: "low",
        ...(thinking ? { thinking } : {}),
        timeoutMs: opts.timeoutMs ?? TIMEOUTS_MS.expansion,
      });
      const added = selectAlternatives(terms, output);
      cache.set(key, added);
      return { added: [...added] };
    } catch (err) {
      return { skipped: err instanceof LlmUnavailable ? err.reason : "llm_error" };
    }
  };
}
