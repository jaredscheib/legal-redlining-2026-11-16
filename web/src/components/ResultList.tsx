import type { ReactNode } from "react";
import { hitKey, type DisplayHit, type SearchState } from "../hooks/useSearch";
import { Shimmer } from "./Shimmer";

export const EXAMPLE_QUERIES = [
  "limitation of liability",
  "return of security deposit",
  "confidential information definition",
];

function Snippet({ hit }: { hit: DisplayHit }) {
  const parts: ReactNode[] = [];
  let at = 0;
  const spans = [...hit.highlights].sort((a, b) => a.start - b.start);
  spans.forEach((h, i) => {
    if (h.start < at) return;
    if (h.start > at) parts.push(hit.snippet.slice(at, h.start));
    parts.push(<mark key={i}>{hit.snippet.slice(h.start, h.end)}</mark>);
    at = h.end;
  });
  if (at < hit.snippet.length) parts.push(hit.snippet.slice(at));
  return <p className="snippet">{parts}</p>;
}

export function ResultList({
  state,
  activeKey,
  currentVersions,
  onOpen,
  onExample,
  onRetry,
}: {
  state: SearchState;
  activeKey: string | null;
  /** Latest known version per document, to flag hits from an older version. */
  currentVersions: Record<string, number>;
  onOpen: (hit: DisplayHit) => void;
  onExample: (q: string) => void;
  onRetry: () => void;
}) {
  const { phase, results } = state;

  if (phase === "idle") {
    return (
      <div className="empty-state">
        <h2>Find a clause</h2>
        <p>Search across every contract. Try one of these:</p>
        <div className="chips">
          {EXAMPLE_QUERIES.map((q) => (
            <button key={q} type="button" className="chip chip-button" onClick={() => onExample(q)}>
              {q}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (phase === "loading" || (phase === "expanding" && results.length === 0)) {
    return (
      <>
        <StatusLine state={state} />
        <Shimmer kind="results" />
      </>
    );
  }

  if (phase === "error") {
    return (
      <div className="notice notice-error" role="alert">
        <p>{state.error}</p>
        <button type="button" className="btn" onClick={onRetry}>
          Retry search
        </button>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <>
        <StatusLine state={state} />
        <div className="empty-state">
          <h2>No results</h2>
          <p>
            Nothing matches “{state.query}”. Try fewer words, a broader term, or drop the quotes
            around a phrase.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <StatusLine state={state} />
      <ul className="result-list" aria-label="Search results">
        {results.map((hit) => {
          const k = hitKey(hit);
          const current = currentVersions[hit.docId];
          const stale = current !== undefined && current > hit.docVersion;
          return (
            <li key={k}>
              <button
                type="button"
                className={`result-row${activeKey === k ? " is-active" : ""}`}
                aria-current={activeKey === k ? "true" : undefined}
                onClick={() => onOpen(hit)}
              >
                <span className="result-title">
                  {hit.title}
                  {stale && <span className="tag">older version</span>}
                </span>
                <Snippet hit={hit} />
                {hit.alsoMatched && hit.alsoMatched.length > 0 && (
                  <span className="also-matched">also matched: {hit.alsoMatched.join(", ")}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function StatusLine({ state }: { state: SearchState }) {
  const { phase, results, total, expansion, expansionFailed } = state;
  return (
    <div className="status-line" aria-live="polite">
      <span>
        {phase === "loading"
          ? "Searching…"
          : `${results.length} ${results.length === 1 ? "passage" : "passages"}${
              total > results.length ? ` of ${total}` : ""
            }`}
      </span>
      {phase === "expanding" && (
        <span className="chip chip-quiet">
          <span className="spinner" aria-hidden="true" /> expanding with synonyms…
        </span>
      )}
      {expansion?.status === "skipped" && (
        <span className="chip chip-quiet">
          synonyms skipped{expansion.reason ? `: ${expansion.reason}` : ""}
        </span>
      )}
      {expansion?.status === "applied" && expansion.added.length > 0 && (
        <span className="chip chip-quiet" title={expansion.added.join(", ")}>
          + {expansion.added.length} synonyms
        </span>
      )}
      {expansionFailed && <span className="chip chip-quiet">synonyms unavailable</span>}
    </div>
  );
}
