/**
 * Evals of the intended lawyer flow, driven in-process through createApp.
 * A measurement, not a gate: failures are data.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createApp } from "../app.js";
import { PASSAGE_MAX_CHARS, PATHS } from "../config.js";
import type {
  Document,
  PatchDocumentResponse,
  SearchHit,
  SearchResponse,
  SuggestionResponse,
} from "../domain/types.js";
import type { AppDeps } from "../routes/deps.js";

export const SearchScenario = z.object({
  id: z.string(),
  query: z.string(),
  mustFindInTop3: z.string(),
  needsExpansion: z.boolean(),
});
export type SearchScenario = z.infer<typeof SearchScenario>;

export const FlowScenario = z.object({
  id: z.string(),
  query: z.string(),
  instruction: z.string(),
  expectInReplacement: z.array(z.string()).optional(),
});
export type FlowScenario = z.infer<typeof FlowScenario>;

export const FLOW_STEPS = [
  "search",
  "pick",
  "suggest",
  "expectations",
  "dry_run",
  "redline",
  "apply",
  "verify_text",
  "search_again",
] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

export interface StepTiming {
  step: string;
  ms: number;
}

export interface SearchCaseResult {
  id: string;
  needsExpansion: boolean;
  pass: boolean;
  /** 1-based rank of the first matching hit, if any. */
  rank?: number;
  reason?: string;
  /** e.g. "applied:3" (alternatives added), "skipped:timeout" or "off". */
  expansion?: string;
  ms: number;
}

export type SuggestionCheckName = "defined_terms" | "clause_number" | "expect_in_replacement";

/** One check of a suggested replacement against its original passage. */
export interface SuggestionCheck {
  name: SuggestionCheckName;
  /** "n/a" when the passage gives the check nothing to look for. */
  status: "pass" | "fail" | "n/a";
  /** What the replacement lost: terms, the clause number, or expected words. */
  missing: string[];
}

export interface FlowCaseResult {
  id: string;
  pass: boolean;
  failedStep?: FlowStep;
  reason?: string;
  steps: StepTiming[];
  /** Empty when the flow failed before the suggestion was checked. */
  checks: SuggestionCheck[];
}

export interface EvalSummary {
  startedAt: string;
  llmMode: string;
  search: {
    total: number;
    hitAt3: number;
    expansionTotal: number;
    hitAt3Expansion: number;
    cases: SearchCaseResult[];
  };
  flow: {
    total: number;
    passRate: number;
    failedAt: Record<string, number>;
    checks: Partial<Record<SuggestionCheckName, { pass: number; fail: number }>>;
    cases: FlowCaseResult[];
  };
  latencyP50Ms: Record<string, number>;
  llm: { liveCalls: number; replayedCalls: number; failedCalls: number; costUsd: number };
}

export function loadScenarios(dir: string = path.join(PATHS.repoRoot, "scenarios")) {
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as unknown;
  return {
    search: z.array(SearchScenario).parse(read("search.json")),
    flow: z.array(FlowScenario).parse(read("flow.json")),
  };
}

// ------------------------------------------------------------------ HTTP helpers

type App = ReturnType<typeof createApp>;

class StepFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function call<T>(app: App, url: string, init?: RequestInit): Promise<T> {
  const res = await app.request(url, init);
  const body = (await res.json().catch(() => ({}))) as {
    details?: { reason?: string };
  };
  if (!res.ok) {
    const reason = body.details?.reason ?? "unknown";
    throw new StepFailure(`http_${res.status}:${reason.toLowerCase()}`);
  }
  return body as T;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function searchUrl(q: string, extra: Record<string, string> = {}): string {
  return `/search?${new URLSearchParams({ q, limit: "10", ...extra }).toString()}`;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }) {
  return a.start < b.end && b.start < a.end;
}

/** Does the hit cover (overlap) any occurrence of `needle` in its document? */
function hitCovers(hit: SearchHit, docText: string, needle: string): boolean {
  if (hit.snippet.includes(needle)) return true;
  for (let i = docText.indexOf(needle); i !== -1; i = docText.indexOf(needle, i + 1)) {
    if (overlaps(hit, { start: i, end: i + needle.length })) return true;
  }
  return false;
}

function occurrenceAt(text: string, needle: string, start: number): number {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1 && i <= start; i = text.indexOf(needle, i + 1)) n++;
  return Math.max(n, 1);
}

/** A distinctive word the replacement added: the longest word not already in the passage. */
export function probeWord(replacement: string, original: string): string | undefined {
  const words = (s: string) => s.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const before = new Set(words(original));
  const added = words(replacement).filter((w) => !before.has(w));
  const pool = added.length > 0 ? added : words(replacement);
  return pool.sort((a, b) => b.length - a.length)[0];
}

/** Words that open sentences in Title case without being defined terms. */
const NOT_DEFINED = new Set(
  (
    "A An And Any All After Before By During Each Either Except For From If In Its No Neither " +
    "Notwithstanding Of On Or Subject Such That The Their These This Those To Unless Upon When " +
    "Where Which While Within"
  ).split(" "),
);

/**
 * Defined terms of a passage: quoted terms ("Confidential Information") and runs of Title-case
 * words (Customer, Expiration Date), minus sentence-opening function words. A heuristic: it
 * reads all-caps text as having none.
 */
export function definedTerms(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/["“]([A-Z][^"”]{0,60})["”]/g)) {
    if (m[1]) found.add(m[1]);
  }
  for (const m of text.matchAll(/\b[A-Z][a-z][A-Za-z-]*(?:\s+[A-Z][a-z][A-Za-z-]*)*\b/g)) {
    const words = m[0].split(/\s+/);
    while (words.length > 0 && NOT_DEFINED.has(words[0] ?? "")) words.shift();
    if (words.length > 0) found.add(words.join(" "));
  }
  return [...found];
}

/** A leading clause number such as "6.2" or "4.", if the passage starts with one. */
export function leadingClauseNumber(text: string): string | undefined {
  return /^\s*(\d+(?:\.\d+)*)\.?(?=\s)/.exec(text)?.[1];
}

const hasWord = (haystack: string, needle: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
    "u",
  ).test(haystack);

/**
 * Checks a replacement against its passage: defined terms survive unless the instruction
 * names them, a leading clause number is kept, and the scenario's expected words appear.
 */
export function checkSuggestion(
  original: string,
  replacement: string,
  sc: Pick<FlowScenario, "instruction" | "expectInReplacement">,
): SuggestionCheck[] {
  const instruction = sc.instruction.toLowerCase();
  const terms = definedTerms(original).filter((t) => !instruction.includes(t.toLowerCase()));
  const lostTerms = terms.filter((t) => !hasWord(replacement, t));

  const number = leadingClauseNumber(original);
  const keptNumber = number === undefined || leadingClauseNumber(replacement) === number;

  const expected = sc.expectInReplacement ?? [];
  const lower = replacement.toLowerCase();
  const missingWords = expected.filter((w) => !lower.includes(w.toLowerCase()));

  const status = (applies: boolean, missing: string[]) =>
    !applies ? "n/a" : missing.length > 0 ? "fail" : "pass";
  return [
    { name: "defined_terms", status: status(terms.length > 0, lostTerms), missing: lostTerms },
    {
      name: "clause_number",
      status: status(number !== undefined, keptNumber ? [] : [number ?? ""]),
      missing: keptNumber ? [] : [number ?? ""],
    },
    {
      name: "expect_in_replacement",
      status: status(expected.length > 0, missingWords),
      missing: missingWords,
    },
  ];
}

async function timed<T>(timings: StepTiming[], step: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    timings.push({ step, ms: performance.now() - t0 });
  }
}

// ------------------------------------------------------------------ runners

export async function runSearchCase(app: App, sc: SearchScenario): Promise<SearchCaseResult> {
  const t0 = performance.now();
  const base = { id: sc.id, needsExpansion: sc.needsExpansion };
  try {
    const res = await call<SearchResponse>(app, searchUrl(sc.query));
    const e = res.expansion;
    const expansion =
      e.status === "applied"
        ? `applied:${e.added.length}`
        : e.reason
          ? `${e.status}:${e.reason}`
          : e.status;
    const docs = new Map<string, string>();
    const top = res.results.slice(0, 3);
    for (const [i, hit] of top.entries()) {
      if (!docs.has(hit.docId)) {
        const d = await call<Document>(app, `/documents/${encodeURIComponent(hit.docId)}`);
        docs.set(hit.docId, d.text);
      }
      if (hitCovers(hit, docs.get(hit.docId) ?? "", sc.mustFindInTop3)) {
        return { ...base, pass: true, rank: i + 1, expansion, ms: performance.now() - t0 };
      }
    }
    return { ...base, pass: false, reason: "not_in_top3", expansion, ms: performance.now() - t0 };
  } catch (err) {
    return { ...base, pass: false, reason: reasonOf(err), ms: performance.now() - t0 };
  }
}

export async function runFlowCase(app: App, sc: FlowScenario): Promise<FlowCaseResult> {
  const steps: StepTiming[] = [];
  let checks: SuggestionCheck[] = [];
  let current: FlowStep = "search";
  const step = <T>(name: FlowStep, fn: () => Promise<T>) => {
    current = name;
    return timed(steps, name, fn);
  };
  try {
    const found = await step("search", () => call<SearchResponse>(app, searchUrl(sc.query)));

    const { hit, passage, doc } = await step("pick", async () => {
      const hit = found.results[0];
      if (!hit) throw new StepFailure("no_results");
      const doc = await call<Document>(app, `/documents/${encodeURIComponent(hit.docId)}`);
      const end = Math.min(hit.end, hit.start + PASSAGE_MAX_CHARS);
      const passage = doc.text.slice(hit.start, end);
      if (!passage.trim()) throw new StepFailure("empty_passage");
      return { hit: { ...hit, end }, passage, doc };
    });

    const suggestion = await step("suggest", () =>
      call<SuggestionResponse>(
        app,
        `/documents/${encodeURIComponent(doc.id)}/suggestions`,
        jsonInit("POST", {
          range: { start: hit.start, end: hit.end },
          instruction: sc.instruction,
        }),
      ),
    );

    await step("expectations", async () => {
      checks = checkSuggestion(passage, suggestion.replacement, sc);
      const failed = checks.filter((ch) => ch.status === "fail");
      if (failed.length > 0) {
        throw new StepFailure(failed.map((ch) => `${ch.name}:${ch.missing.join(",")}`).join(";"));
      }
    });

    const patch = {
      changes: [
        {
          operation: "replace",
          target: { text: passage, occurrence: occurrenceAt(doc.text, passage, hit.start) },
          replacement: suggestion.replacement,
        },
      ],
    };
    const docUrl = `/documents/${encodeURIComponent(doc.id)}`;

    const preview = await step("dry_run", () =>
      call<PatchDocumentResponse>(app, `${docUrl}?dryRun=true`, jsonInit("PATCH", patch)),
    );

    await step("redline", async () => {
      const changed = preview.redline.some((h) =>
        h.segments.some((s) => s.type === "delete" || s.type === "insert"),
      );
      if (!changed) throw new StepFailure("no_delete_or_insert_segment");
      const after = await call<Document>(app, docUrl);
      if (after.version !== doc.version) throw new StepFailure("dry_run_mutated_document");
    });

    await step("apply", () => call<PatchDocumentResponse>(app, docUrl, jsonInit("PATCH", patch)));

    await step("verify_text", async () => {
      const after = await call<Document>(app, docUrl);
      if (!after.text.includes(suggestion.replacement)) throw new StepFailure("replacement_absent");
      if (after.version <= doc.version) throw new StepFailure("version_not_bumped");
    });

    await step("search_again", async () => {
      const word = probeWord(suggestion.replacement, passage);
      if (!word) throw new StepFailure("no_probe_word");
      const again = await call<SearchResponse>(app, searchUrl(word, { docId: doc.id }));
      const ok = again.results.some(
        (r) => r.docId === doc.id && r.snippet.toLowerCase().includes(word),
      );
      if (!ok) throw new StepFailure(`not_found:${word}`);
    });

    return { id: sc.id, pass: true, steps, checks };
  } catch (err) {
    return { id: sc.id, pass: false, failedStep: current, reason: reasonOf(err), steps, checks };
  }
}

function reasonOf(err: unknown): string {
  if (err instanceof StepFailure) return err.reason;
  if (err instanceof Error) return `crash:${err.name}`;
  return "crash";
}

export function p50(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const v =
    sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return Math.round(v * 10) / 10;
}

export interface RunOptions {
  /** Fresh dependencies per flow, so applied edits never leak between cases. */
  makeDeps: () => AppDeps;
  llmStats: () => EvalSummary["llm"];
  llmMode: string;
  scenarios: { search: SearchScenario[]; flow: FlowScenario[] };
}

export async function runEvals(opts: RunOptions): Promise<EvalSummary> {
  const startedAt = new Date().toISOString();
  const searchApp = createApp(opts.makeDeps());
  const searchCases: SearchCaseResult[] = [];
  for (const sc of opts.scenarios.search) searchCases.push(await runSearchCase(searchApp, sc));

  const flowCases: FlowCaseResult[] = [];
  for (const sc of opts.scenarios.flow) {
    flowCases.push(await runFlowCase(createApp(opts.makeDeps()), sc));
  }

  const latencies = new Map<string, number[]>();
  const add = (step: string, ms: number) =>
    latencies.set(step, [...(latencies.get(step) ?? []), ms]);
  for (const c of searchCases) add("search", c.ms);
  for (const c of flowCases) for (const t of c.steps) add(t.step, t.ms);

  const exp = searchCases.filter((c) => c.needsExpansion);
  const rate = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 1000);
  const failedAt: Record<string, number> = {};
  for (const c of flowCases) {
    if (c.failedStep) failedAt[c.failedStep] = (failedAt[c.failedStep] ?? 0) + 1;
  }

  return {
    startedAt,
    llmMode: opts.llmMode,
    search: {
      total: searchCases.length,
      hitAt3: rate(searchCases.filter((c) => c.pass).length, searchCases.length),
      expansionTotal: exp.length,
      hitAt3Expansion: rate(exp.filter((c) => c.pass).length, exp.length),
      cases: searchCases,
    },
    flow: {
      total: flowCases.length,
      passRate: rate(flowCases.filter((c) => c.pass).length, flowCases.length),
      failedAt,
      checks: tallyChecks(flowCases),
      cases: flowCases,
    },
    latencyP50Ms: Object.fromEntries(
      [...latencies].map(([step, values]) => [step, p50(values)] as const),
    ),
    llm: opts.llmStats(),
  };
}

/** Per check: flows where it passed and failed (n/a not counted). */
function tallyChecks(cases: FlowCaseResult[]): EvalSummary["flow"]["checks"] {
  const out: EvalSummary["flow"]["checks"] = {};
  for (const ch of cases.flatMap((c) => c.checks)) {
    const t = (out[ch.name] ??= { pass: 0, fail: 0 });
    if (ch.status === "pass") t.pass++;
    if (ch.status === "fail") t.fail++;
  }
  return out;
}

export function formatReport(s: EvalSummary): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const lines: string[] = [];
  lines.push(`Evals  ${s.startedAt}  LLM_MODE=${s.llmMode}`, "");
  lines.push("SEARCH                                     pass  rank  reason        expansion");
  for (const c of s.search.cases) {
    const tag = c.needsExpansion ? " [exp]" : "";
    lines.push(
      `  ${(c.id + tag).padEnd(41)}${(c.pass ? "PASS" : "FAIL").padEnd(6)}${String(c.rank ?? "-").padEnd(6)}${(c.reason ?? "").padEnd(14)}${c.expansion ?? ""}`,
    );
  }
  lines.push("", "FLOW                                       pass  failed at     reason");
  for (const c of s.flow.cases) {
    lines.push(
      `  ${c.id.padEnd(41)}${(c.pass ? "PASS" : "FAIL").padEnd(6)}${(c.failedStep ?? "-").padEnd(14)}${c.reason ?? ""}`,
    );
    if (c.checks.length > 0) {
      lines.push(`    checks: ${c.checks.map((ch) => `${ch.name}=${ch.status}`).join(" ")}`);
    }
  }
  lines.push("", "METRICS");
  lines.push(`  search hit@3              ${pct(s.search.hitAt3)} of ${s.search.total}`);
  lines.push(
    `  search hit@3 (expansion)  ${pct(s.search.hitAt3Expansion)} of ${s.search.expansionTotal}`,
  );
  lines.push(`  flow pass rate            ${pct(s.flow.passRate)} of ${s.flow.total}`);
  const checks = Object.entries(s.flow.checks)
    .map(([k, v]) => `${k}=${v.pass}/${v.pass + v.fail}`)
    .join(" ");
  lines.push(`  suggestion checks         ${checks || "-"}`);
  const failed = Object.entries(s.flow.failedAt)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  lines.push(`  flow failed at            ${failed || "-"}`);
  const p = Object.entries(s.latencyP50Ms)
    .map(([k, v]) => `${k}=${v}ms`)
    .join(" ");
  lines.push(`  p50 latency               ${p || "-"}`);
  lines.push(
    `  llm calls                 live=${s.llm.liveCalls} replayed=${s.llm.replayedCalls} failed=${s.llm.failedCalls} spent=$${s.llm.costUsd.toFixed(4)}`,
  );
  return lines.join("\n");
}
