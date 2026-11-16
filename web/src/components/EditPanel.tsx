import { useState } from "react";
import {
  ApiFailure,
  describeError,
  isClaudeUnavailable,
  isVersionConflict,
  patchDocument,
  suggest,
} from "../api/client";
import {
  PASSAGE_MAX_CHARS,
  type PatchDocumentResponse,
  type RedlineHunk,
  type ReplaceChange,
} from "../api/types";
import { logEvent } from "../lib/text";
import { Redline } from "./Redline";

export interface Selection {
  docId: string;
  start: number;
  end: number;
  text: string;
}

type Busy = "suggest" | "preview" | "apply" | null;

/** 422 reasons meaning the selected range no longer holds the selected text. */
const STALE_SELECTION = ["EXPECTED_TEXT_MISMATCH", "RANGE_OUT_OF_BOUNDS"];

/** Edit the selected passage: write or suggest a replacement, preview the redline, apply it. */
export function EditPanel({
  selection,
  docVersion,
  onApplied,
  onReload,
  onClose,
}: {
  selection: Selection;
  /** Version of the open document, sent as If-Match on preview and apply. */
  docVersion: number;
  onApplied: (res: PatchDocumentResponse, replacement: string) => void;
  onReload: () => void;
  onClose: () => void;
}) {
  const [replacement, setReplacement] = useState(selection.text);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [claudeUnavailable, setClaudeUnavailable] = useState(false);
  const [rationale, setRationale] = useState<string | null>(null);
  const [preview, setPreview] = useState<RedlineHunk[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the document changed under the panel; the fix is to reload it.
  const [needsReload, setNeedsReload] = useState(false);

  const unchanged = replacement === selection.text;
  const tooLongForClaude = selection.end - selection.start > PASSAGE_MAX_CHARS;

  const change = (): ReplaceChange => ({
    operation: "replace",
    range: { start: selection.start, end: selection.end, expectedText: selection.text },
    replacement,
  });

  const fail = (err: unknown, action: string) => {
    if (isVersionConflict(err)) {
      setNeedsReload(true);
      setError("This document changed since you opened it.");
    } else if (
      err instanceof ApiFailure &&
      err.status === 422 &&
      STALE_SELECTION.includes(err.reason)
    ) {
      setNeedsReload(true);
      setError("This passage changed since you selected it, so the edit can't be placed.");
    } else {
      setError(describeError(err, action));
    }
  };

  const onSuggest = async () => {
    setBusy("suggest");
    setError(null);
    try {
      const res = await suggest(
        selection.docId,
        { start: selection.start, end: selection.end },
        instruction.trim() || undefined,
      );
      setReplacement(res.replacement);
      setRationale(res.rationale);
      setPreview(null);
    } catch (err) {
      if (isClaudeUnavailable(err)) setClaudeUnavailable(true);
      else fail(err, "asking Claude for a suggestion");
    } finally {
      setBusy(null);
    }
  };

  const onPreview = async () => {
    setBusy("preview");
    setError(null);
    try {
      const res = await patchDocument(selection.docId, change(), true, docVersion);
      setPreview(res.redline);
      logEvent("preview", { changes: 1, hunks: res.redline.length });
    } catch (err) {
      fail(err, "previewing the change");
    } finally {
      setBusy(null);
    }
  };

  const onApply = async () => {
    setBusy("apply");
    setError(null);
    try {
      const res = await patchDocument(selection.docId, change(), false, docVersion);
      logEvent("apply", { changes: 1, hunks: res.redline.length, version: res.version });
      setBusy(null);
      onApplied(res, replacement);
    } catch (err) {
      fail(err, "applying the change");
      setBusy(null);
    }
  };

  return (
    <section className="edit-panel" aria-label="Edit passage">
      <header className="edit-header">
        <h2>Edit selection</h2>
        <span className="muted">
          {selection.text.length} characters at {selection.start}
        </span>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </header>

      <label htmlFor="replacement">Replacement</label>
      <textarea
        id="replacement"
        rows={4}
        value={replacement}
        onChange={(e) => {
          setReplacement(e.target.value);
          setPreview(null);
        }}
      />

      <div className="suggest-row">
        {claudeUnavailable ? (
          <p className="notice notice-quiet" role="status">
            Claude unavailable — write the change yourself
          </p>
        ) : (
          <>
            <input
              type="text"
              aria-label="Instruction for Claude (optional)"
              placeholder="Optional instruction, e.g. make the cap twelve months"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={tooLongForClaude}
            />
            <button
              type="button"
              className="btn"
              onClick={onSuggest}
              disabled={busy !== null || tooLongForClaude}
              title={
                tooLongForClaude
                  ? `Select at most ${PASSAGE_MAX_CHARS} characters for a suggestion`
                  : undefined
              }
            >
              <span
                className={busy === "suggest" ? "spinner" : "spinner spinner-idle"}
                aria-hidden="true"
              />
              {busy === "suggest" ? "Asking Claude…" : "Suggest"}
            </button>
          </>
        )}
      </div>
      {rationale && <p className="rationale">Claude: {rationale}</p>}

      <div className={preview ? "preview-box" : "preview-tip"} aria-live="polite">
        {busy === "preview" ? (
          <p className="tip">Building the redline…</p>
        ) : preview ? (
          preview.map((hunk) => <Redline key={hunk.changeIndex} hunk={hunk} />)
        ) : (
          <p className="tip">
            <InfoGlyph />
            {unchanged
              ? "Change the text, then preview the redline."
              : "Preview to see the redline."}
          </p>
        )}
      </div>

      {error && (
        <div className="notice notice-error" role="alert">
          <p>{error}</p>
          {needsReload && (
            <button type="button" className="btn" onClick={onReload}>
              Reload document
            </button>
          )}
        </div>
      )}

      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={onPreview}
          disabled={busy !== null || unchanged}
        >
          <span
            className={busy === "preview" ? "spinner" : "spinner spinner-idle"}
            aria-hidden="true"
          />
          Preview
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onApply}
          disabled={busy !== null || unchanged}
        >
          <span
            className={busy === "apply" ? "spinner" : "spinner spinner-idle"}
            aria-hidden="true"
          />
          {busy === "apply" ? "Applying…" : "Apply"}
        </button>
      </div>
    </section>
  );
}

/** A small circled "i" for tips; decorative. */
function InfoGlyph() {
  return (
    <svg className="tip-glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7.25" y="7" width="1.5" height="5" rx="0.75" fill="currentColor" />
      <circle cx="8" cy="4.75" r="1" fill="currentColor" />
    </svg>
  );
}
