import type { RedlineHunk } from "../api/types";

/** One hunk as an inline redline: context, then deleted words struck through and insertions underlined. */
export function Redline({ hunk }: { hunk: RedlineHunk }) {
  return (
    <p className="redline" data-testid="redline">
      {hunk.before && <span className="redline-context">{hunk.before}</span>}
      {hunk.segments.map((seg, i) => {
        if (seg.type === "delete") {
          return (
            <del key={i} className="redline-del">
              {seg.text}
            </del>
          );
        }
        if (seg.type === "insert") {
          return (
            <ins key={i} className="redline-ins">
              {seg.text}
            </ins>
          );
        }
        return <span key={i}>{seg.text}</span>;
      })}
      {hunk.after && <span className="redline-context">{hunk.after}</span>}
    </p>
  );
}
