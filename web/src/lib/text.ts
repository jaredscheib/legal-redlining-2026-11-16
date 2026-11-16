/**
 * The 1-based occurrence of `needle` that starts at `start` in `text`: 1 plus the number of
 * non-overlapping occurrences (scanning from the start) that end at or before `start`.
 */
export function computeOccurrence(text: string, needle: string, start: number): number {
  if (!needle) return 1;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1 || idx + needle.length > start) break;
    count += 1;
    from = idx + needle.length;
  }
  return count + 1;
}

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
