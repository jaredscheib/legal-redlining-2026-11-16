import { useEffect, useRef } from "react";
import type { DocumentBody } from "../api/types";
import { rangeToOffsets } from "../lib/text";
import { Shimmer } from "./Shimmer";

export interface TextRange {
  start: number;
  end: number;
}

/**
 * The document as pre-wrapped text. The highlighted range is marked and scrolled into view;
 * selecting text reports its offsets into the document.
 */
export function DocumentView({
  doc,
  loading,
  highlight,
  onSelectText,
}: {
  doc: DocumentBody | null;
  loading: boolean;
  highlight: TextRange | null;
  onSelectText: (range: TextRange) => void;
}) {
  const textRef = useRef<HTMLPreElement>(null);
  const markRef = useRef<HTMLElement>(null);

  useEffect(() => {
    markRef.current?.scrollIntoView?.({ block: "center" });
  }, [doc?.id, doc?.version, highlight?.start, highlight?.end]);

  if (loading) return <Shimmer kind="document" />;
  if (!doc) {
    return (
      <div className="empty-state">
        <h2>No document open</h2>
        <p>
          Pick a search result to open its document at that passage, or choose a document above.
        </p>
      </div>
    );
  }

  const onMouseUp = () => {
    const container = textRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.rangeCount === 0) return;
    const offsets = rangeToOffsets(container, selection.getRangeAt(0));
    if (offsets) onSelectText(offsets);
  };

  const h =
    highlight && highlight.end <= doc.text.length && highlight.end > highlight.start
      ? highlight
      : null;

  return (
    <article className="doc-view">
      <header className="doc-header">
        <h2>{doc.title}</h2>
        <span className="tag">version {doc.version}</span>
      </header>
      <pre ref={textRef} className="doc-text" data-testid="doc-text" onMouseUp={onMouseUp}>
        {h ? (
          <>
            {doc.text.slice(0, h.start)}
            <mark ref={markRef} className="doc-selection">
              {doc.text.slice(h.start, h.end)}
            </mark>
            {doc.text.slice(h.end)}
          </>
        ) : (
          doc.text
        )}
      </pre>
    </article>
  );
}
