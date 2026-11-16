import type { ReactNode } from "react";
import type { DocumentSummary } from "../api/types";
import { hitKey, type DisplayHit, type SearchState } from "../hooks/useSearch";
import { plural } from "../lib/text";
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
  library,
  onOpen,
  onOpenDocument,
  onExample,
  onRetry,
}: {
  state: SearchState;
  activeKey: string | null;
  /** Latest known version per document, to flag hits from an older version. */
  currentVersions: Record<string, number>;
  /** Every document, listed on the home state. */
  library: DocumentSummary[];
  onOpen: (hit: DisplayHit) => void;
  onOpenDocument: (docId: string) => void;
  onExample: (q: string) => void;
  onRetry: () => void;
}) {
  const { phase, results } = state;

  if (phase === "idle") {
    return (
      <div className="home">
        <div className="empty-state">
          <h2>Find a clause</h2>
          <p>Search across every contract. Try one of these:</p>
          <div className="chips">
            {EXAMPLE_QUERIES.map((q) => (
              <button
                key={q}
                type="button"
                className="chip chip-button"
                onClick={() => onExample(q)}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
        <section aria-labelledby="library-heading">
          <h2 id="library-heading" className="section-heading">
            Or open a document
          </h2>
          {library.length === 0 ? (
            <p className="muted">No documents loaded.</p>
          ) : (
            <ul className="doc-list" aria-label="All documents">
              {library.map((d) => (
                <li key={d.id}>
                  <button type="button" className="doc-row" onClick={() => onOpenDocument(d.id)}>
                    <span className="doc-row-title">{d.title}</span>
                    <span className="doc-row-meta">
                      {plural(d.length, "character")} · v{currentVersions[d.id] ?? d.version}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
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
      {state.documents.length > 0 && (
        <section aria-labelledby="matching-docs-heading" className="matching-docs">
          <h3 id="matching-docs-heading" className="section-heading">
            Documents
          </h3>
          <ul className="doc-list" aria-label="Matching documents">
            {state.documents.map((d) => (
              <li key={d.docId}>
                <button
                  type="button"
                  className="doc-row doc-row-compact"
                  onClick={() => onOpenDocument(d.docId)}
                >
                  <span className="doc-row-title">{d.title}</span>
                  <span className="doc-row-meta">{plural(d.passages, "passage")}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <h3 className="section-heading">Passages</h3>
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
                  {hit.stale ? (
                    <span className="tag">updating</span>
                  ) : (
                    stale && <span className="tag">older version</span>
                  )}
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

/**
 * A quiet note, inside the status line so it never moves the results, while the server is
 * still reindexing a document the results come from.
 */
function IndexingNotice({ state }: { state: SearchState }) {
  if (state.phase === "loading" || state.indexing.length === 0) return null;
  const text = state.indexing
    .map((d) => `Updating ${d.title} (v${d.indexedVersion} → v${d.currentVersion})`)
    .join("; ");
  return (
    <span className="indexing-notice" title={`${text} — results may be out of date`}>
      {text} — results may be out of date
    </span>
  );
}

function StatusLine({ state }: { state: SearchState }) {
  const { phase, results, total, documents } = state;
  return (
    <div className="status-line" aria-live="polite">
      {phase === "loading" ? (
        <span>Searching…</span>
      ) : (
        <h2 className="result-count">
          {plural(total, "passage")} across {plural(documents.length, "document")}
          {total > results.length && (
            <span className="muted result-count-shown"> · showing {results.length}</span>
          )}
        </h2>
      )}
      <IndexingNotice state={state} />
    </div>
  );
}
