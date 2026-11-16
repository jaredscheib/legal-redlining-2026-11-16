import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, isAbort, search } from "../api/client";
import type { SearchDocumentCount, SearchExpansion, SearchHit } from "../api/types";
import { logEvent } from "../lib/text";

export interface DisplayHit extends SearchHit {
  /** Synonyms that matched, set on hits that only the expanded search found. */
  alsoMatched?: string[];
}

export type SearchPhase = "idle" | "loading" | "expanding" | "done" | "error";

export interface SearchState {
  query: string;
  phase: SearchPhase;
  results: DisplayHit[];
  /** Matching passages across all pages, from the latest completed phase. */
  total: number;
  /** Per-document passage counts, from the latest completed phase. */
  documents: SearchDocumentCount[];
  expansion: SearchExpansion | null;
  /** Set when the expanded pass failed; the first-pass results stay. */
  expansionFailed: boolean;
  error: string | null;
}

const initial: SearchState = {
  query: "",
  phase: "idle",
  results: [],
  total: 0,
  documents: [],
  expansion: null,
  expansionFailed: false,
  error: null,
};

export const hitKey = (h: { docId: string; start: number }) => `${h.docId}:${h.start}`;

/** Merges expanded hits whose passages aren't shown yet, marking the synonyms they matched. */
export function mergeExpanded(
  shown: DisplayHit[],
  expanded: SearchHit[],
  added: string[],
): DisplayHit[] {
  const seen = new Set(shown.map(hitKey));
  const addedSet = new Set(added.map((t) => t.toLowerCase()));
  const extra: DisplayHit[] = [];
  for (const hit of expanded) {
    if (seen.has(hitKey(hit))) continue;
    seen.add(hitKey(hit));
    extra.push({
      ...hit,
      alsoMatched: hit.matchedTerms.filter((t) => addedSet.has(t.toLowerCase())),
    });
  }
  return [...shown, ...extra];
}

/** Two-phase search: plain results at once, then (when `expand`) synonym-expanded ones merged in. */
export function useSearch() {
  const [state, setState] = useState<SearchState>(initial);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const run = useCallback(async (raw: string, expand = true) => {
    const q = raw.trim();
    controller.current?.abort();
    if (!q) {
      controller.current = null;
      setState(initial);
      return;
    }
    const ac = new AbortController();
    controller.current = ac;
    setState({ ...initial, query: q, phase: "loading" });

    let shown: DisplayHit[];
    try {
      const first = await search(q, false, ac.signal);
      if (ac.signal.aborted) return;
      shown = first.results;
      logEvent("search", { phase: "plain", results: first.results.length, total: first.total });
      setState({
        ...initial,
        query: q,
        phase: expand ? "expanding" : "done",
        results: shown,
        total: first.total,
        documents: first.documents,
      });
    } catch (err) {
      if (isAbort(err) || ac.signal.aborted) return;
      setState({ ...initial, query: q, phase: "error", error: describeError(err, "searching") });
      return;
    }

    if (!expand) return;

    try {
      const second = await search(q, true, ac.signal);
      if (ac.signal.aborted) return;
      const merged = mergeExpanded(shown, second.results, second.expansion.added);
      logEvent("search", {
        phase: "expanded",
        results: second.results.length,
        added: second.expansion.added.length,
        merged: merged.length - shown.length,
      });
      setState((s) => ({
        ...s,
        phase: "done",
        results: merged,
        // Counts come from the expanded phase, so the total and the per-document counts agree.
        total: second.total,
        documents: second.documents,
        expansion: second.expansion,
      }));
    } catch (err) {
      if (isAbort(err) || ac.signal.aborted) return;
      setState((s) => ({ ...s, phase: "done", expansionFailed: true }));
    }
  }, []);

  return { state, run };
}
