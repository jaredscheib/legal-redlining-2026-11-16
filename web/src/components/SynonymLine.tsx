import type { ReactNode } from "react";
import type { SearchState } from "../hooks/useSearch";

/**
 * The quiet line under the search box: the synonyms being searched, or the expansion's progress
 * or why it didn't happen. The line keeps its height when empty so nothing below it shifts.
 */
export function SynonymLine({ state, on }: { state: SearchState; on: boolean }) {
  const { phase, expansion, expansionFailed } = state;
  let content: ReactNode = null;
  if (!on) {
    // Synonyms off: the line stays empty.
  } else if (phase === "expanding") {
    content = (
      <span className="chip chip-quiet">
        <span className="spinner" aria-hidden="true" /> expanding with synonyms…
      </span>
    );
  } else if (expansionFailed) {
    content = <span className="chip chip-quiet">synonyms unavailable</span>;
  } else if (expansion?.status === "skipped") {
    content = (
      <span className="chip chip-quiet">
        synonyms skipped{expansion.reason ? `: ${expansion.reason}` : ""}
      </span>
    );
  } else if (expansion?.status === "applied" && expansion.added.length > 0) {
    content = (
      <>
        <span id="also-searching-label">Also searching:</span>
        <ul className="synonym-chips" aria-labelledby="also-searching-label">
          {expansion.added.map((term) => (
            <li key={term} className="chip chip-quiet chip-small">
              {term}
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <div className="synonym-line" data-testid="synonym-line" aria-live="polite">
      {content}
    </div>
  );
}
