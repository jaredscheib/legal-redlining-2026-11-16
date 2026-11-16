/** Loading skeletons shaped like the content they stand in for. */
export function Shimmer({ kind, count = 4 }: { kind: "results" | "document"; count?: number }) {
  if (kind === "results") {
    return (
      <ul className="result-list" aria-busy="true" aria-label="Loading results">
        {Array.from({ length: count }, (_, i) => (
          <li key={i} className="result-row shimmer-row" data-testid="shimmer-row">
            <span className="shimmer shimmer-title" />
            <span className="shimmer shimmer-line" />
            <span className="shimmer shimmer-line shimmer-short" />
          </li>
        ))}
      </ul>
    );
  }
  const widths = [96, 100, 88, 100, 72, 0, 100, 94, 100, 60, 0, 98, 100, 84];
  return (
    <div className="doc-shimmer" aria-busy="true" aria-label="Loading document">
      <span className="shimmer shimmer-heading" />
      {widths.map((w, i) =>
        w === 0 ? (
          <span key={i} className="shimmer-gap" />
        ) : (
          <span key={i} className="shimmer shimmer-text" style={{ width: `${w}%` }} />
        ),
      )}
    </div>
  );
}
