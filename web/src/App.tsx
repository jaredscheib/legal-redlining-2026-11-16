import { useEffect, useRef, useState } from "react";
import { describeError, getDocument, isAbort, listDocuments } from "./api/client";
import type { DocumentBody, DocumentSummary, PatchDocumentResponse } from "./api/types";
import { DocumentView, type TextRange } from "./components/DocumentView";
import { EditPanel, type Selection } from "./components/EditPanel";
import { ResultList } from "./components/ResultList";
import { SearchBar } from "./components/SearchBar";
import { SynonymLine } from "./components/SynonymLine";
import { SynonymToggle } from "./components/SynonymToggle";
import { hitKey, useSearch, type DisplayHit } from "./hooks/useSearch";
import { loadSynonyms, saveSynonyms } from "./lib/prefs";
import { plural } from "./lib/text";

interface Applied {
  version: number;
  changes: number;
}

export function App({ version }: { version: string }) {
  const [query, setQuery] = useState("");
  const { state: searchState, run } = useSearch();
  const [synonyms, setSynonyms] = useState(loadSynonyms);

  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [doc, setDoc] = useState<DocumentBody | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<{ id: string; message: string } | null>(null);
  const [highlight, setHighlight] = useState<TextRange | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  // Set when a clicked hit predates the loaded document, so its offsets may be wrong.
  const [staleHit, setStaleHit] = useState(false);
  const docRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    listDocuments(ac.signal)
      .then(({ documents }) => {
        setDocuments(documents);
        setVersions(Object.fromEntries(documents.map((d) => [d.id, d.version])));
      })
      .catch(() => {
        // The picker is a convenience; search and result clicks still open documents.
      });
    return () => ac.abort();
  }, []);

  const loadDoc = async (id: string, range?: TextRange, hitVersion?: number) => {
    docRequest.current?.abort();
    const ac = new AbortController();
    docRequest.current = ac;
    setDocLoading(true);
    setDocError(null);
    setStaleHit(false);
    setSelection(null);
    setHighlight(null);
    try {
      const loaded = await getDocument(id, ac.signal);
      if (ac.signal.aborted) return;
      setDoc(loaded);
      setVersions((v) => ({ ...v, [loaded.id]: loaded.version }));
      if (range) openRange(loaded, range, hitVersion);
    } catch (err) {
      if (isAbort(err) || ac.signal.aborted) return;
      setDocError({ id, message: describeError(err, "opening the document") });
    } finally {
      if (!ac.signal.aborted) setDocLoading(false);
    }
  };

  const selectRange = (d: DocumentBody, range: TextRange) => {
    const end = Math.min(range.end, d.text.length);
    if (end <= range.start) return;
    setStaleHit(false);
    setHighlight({ start: range.start, end });
    setSelection({ docId: d.id, start: range.start, end, text: d.text.slice(range.start, end) });
    setApplied(null);
  };

  /** Opens a search hit's range, unless the hit is from an older version of the document. */
  const openRange = (d: DocumentBody, range: TextRange, hitVersion?: number) => {
    if (hitVersion !== undefined && hitVersion < d.version) {
      setSelection(null);
      setHighlight(null);
      setApplied(null);
      setStaleHit(true);
      return;
    }
    selectRange(d, range);
  };

  const onSearch = (q: string) => {
    setActiveKey(null);
    void run(q, synonyms);
  };

  /** The search box was emptied: drop the search and its results. */
  const onClearSearch = () => {
    setActiveKey(null);
    void run("", synonyms);
  };

  /** Back to the home state; any search results stay. */
  const closeDocument = () => {
    docRequest.current?.abort();
    docRequest.current = null;
    setDoc(null);
    setDocLoading(false);
    setDocError(null);
    setHighlight(null);
    setSelection(null);
    setApplied(null);
    setStaleHit(false);
    setActiveKey(null);
  };

  const openDocument = (id: string) => {
    setActiveKey(null);
    setApplied(null);
    void loadDoc(id);
  };

  const onToggleSynonyms = (on: boolean) => {
    setSynonyms(on);
    saveSynonyms(on);
    if (searchState.query) void run(searchState.query, on);
  };

  const onExample = (q: string) => {
    setQuery(q);
    onSearch(q);
  };

  const openHit = (hit: DisplayHit) => {
    setActiveKey(hitKey(hit));
    const range = { start: hit.start, end: hit.end };
    if (doc && doc.id === hit.docId && !docLoading) openRange(doc, range, hit.docVersion);
    else void loadDoc(hit.docId, range, hit.docVersion);
  };

  const onApplied = (res: PatchDocumentResponse, replacement: string) => {
    if (!doc || !selection) return;
    setDoc({ ...doc, text: res.text, version: res.version });
    setVersions((v) => ({ ...v, [res.id]: res.version }));
    setDocuments((ds) =>
      ds.map((d) =>
        d.id === res.id ? { ...d, version: res.version, length: res.text.length } : d,
      ),
    );
    setHighlight({ start: selection.start, end: selection.start + replacement.length });
    setSelection(null);
    setApplied({ version: res.version, changes: 1 });
    // Re-run the search so result offsets match the new text.
    if (searchState.query) void run(searchState.query, synonyms);
  };

  const busySearching = searchState.phase === "loading" || searchState.phase === "expanding";

  return (
    <div className="app">
      <header className="app-header">
        <h1>Redline</h1>
        <div className="search-column">
          <SearchBar
            value={query}
            onChange={setQuery}
            onSearch={onSearch}
            onClear={onClearSearch}
            busy={busySearching}
          />
          <SynonymLine state={searchState} on={synonyms} />
        </div>
        <SynonymToggle on={synonyms} onChange={onToggleSynonyms} />
      </header>
      <main className="workspace">
        <section className="results-pane" aria-label="Results">
          <ResultList
            state={searchState}
            activeKey={activeKey}
            currentVersions={versions}
            library={documents}
            onOpen={openHit}
            onOpenDocument={openDocument}
            onExample={onExample}
            onRetry={() => onSearch(searchState.query)}
          />
        </section>
        <section className="doc-pane" aria-label="Document">
          <div className="doc-toolbar">
            <label htmlFor="doc-picker">Document</label>
            <select
              id="doc-picker"
              value={doc?.id ?? ""}
              onChange={(e) => {
                if (e.target.value) openDocument(e.target.value);
              }}
            >
              <option value="" disabled>
                {documents.length ? "Choose a document…" : "No documents loaded"}
              </option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
            {(doc || docLoading || docError) && (
              <button type="button" className="btn btn-ghost doc-close" onClick={closeDocument}>
                <span aria-hidden="true">×</span>
                Close document
              </button>
            )}
          </div>
          <div className="doc-scroll">
            {docError ? (
              <div className="notice notice-error" role="alert">
                <p>{docError.message}</p>
                <button type="button" className="btn" onClick={() => void loadDoc(docError.id)}>
                  Try again
                </button>
              </div>
            ) : (
              <DocumentView
                doc={doc}
                loading={docLoading}
                highlight={highlight}
                onSelectText={(range) => {
                  if (doc) selectRange(doc, range);
                }}
              />
            )}
          </div>
          <div className="dock">
            {selection && doc ? (
              <EditPanel
                key={`${selection.docId}:${doc.version}:${selection.start}:${selection.end}`}
                selection={selection}
                docText={doc.text}
                onApplied={onApplied}
                onReload={() => void loadDoc(doc.id)}
                onClose={() => {
                  setSelection(null);
                  setHighlight(null);
                }}
              />
            ) : staleHit ? (
              <p className="notice notice-quiet" role="status">
                This passage may have moved — search again.
              </p>
            ) : applied ? (
              <p className="notice notice-success" role="status">
                Applied {plural(applied.changes, "change")}. Now version {applied.version}.
              </p>
            ) : (
              <p className="muted dock-hint">
                {doc
                  ? "Select any text in the document to edit it."
                  : "Open a document to start editing."}
              </p>
            )}
          </div>
        </section>
      </main>
      <footer className="app-footer">
        <small>Version {version}</small>
      </footer>
    </div>
  );
}
