/**
 * Maps a DOM range inside `container` to [start, end) offsets into the container's text.
 * Returns null when the range is collapsed or reaches outside the container.
 */
export function rangeToOffsets(
  container: Node,
  range: Range,
): { start: number; end: number } | null {
  if (range.collapsed) return null;
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }
  const head = document.createRange();
  head.selectNodeContents(container);
  head.setEnd(range.startContainer, range.startOffset);
  const start = head.toString().length;
  const end = start + range.toString().length;
  return end > start ? { start, end } : null;
}

/** Client event log: JSON on console.info, counts only (never query or document text). */
export function logEvent(event: string, fields: Record<string, number | string | boolean>) {
  console.info(JSON.stringify({ event, ...fields }));
}

/** "1 passage", "3 passages": the count with the word, plural unless the count is 1. */
export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? word : many}`;
}
