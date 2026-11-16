import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import type { SearchHit, SearchResponse } from "./api/types";

const TEXT = "Liability is capped at six months of fees. Either party may terminate on notice.";

const doc = { id: "msa", title: "SaaS MSA", text: TEXT, version: 2 };

const hit = (over: Partial<SearchHit>): SearchHit => ({
  docId: "msa",
  title: "SaaS MSA",
  docVersion: 2,
  start: 0,
  end: 42,
  snippet: "Liability is capped at six months of fees.",
  highlights: [{ start: 0, end: 9 }],
  score: 1,
  matchedTerms: ["liability"],
  ...over,
});

const searchBody = (over: Partial<SearchResponse>): SearchResponse => ({
  query: "q",
  terms: ["q"],
  phrases: [],
  expansion: { status: "off", added: [] },
  total: 0,
  results: [],
  documents: [],
  ...over,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

let fetchMock: Mock<(input: string, init?: RequestInit) => Promise<Response>>;

function mockApi(routes: Record<string, Handler>) {
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const handler = routes[key];
    if (handler) return handler(url, init);
    if (key === "GET /documents") {
      return json(200, { documents: [{ id: "msa", title: "SaaS MSA", version: 2, length: 80 }] });
    }
    if (key === "GET /documents/msa") return json(200, doc);
    return json(404, { error: "not found", code: 404, details: { reason: "ROUTE_NOT_FOUND" } });
  });
  vi.stubGlobal("fetch", fetchMock);
}

const calls = (method: string, path: string) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const url = new URL(input, "http://localhost");
    return (init?.method ?? "GET") === method && url.pathname === path;
  });

/** The i-th call to a route, parsed: its URL and JSON body. */
function call(method: string, path: string, i = 0): { url: URL; body: unknown } {
  const found = calls(method, path)[i];
  if (!found) throw new Error(`no call ${i} to ${method} ${path}`);
  const [input, init] = found;
  return {
    url: new URL(input, "http://localhost"),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  };
}

function search(q: string) {
  fireEvent.change(screen.getByLabelText("Search contracts"), { target: { value: q } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App", () => {
  it("shows the empty state with example chips and the version", async () => {
    mockApi({});
    render(<App version="abc1234" />);
    expect(screen.getByRole("heading", { name: "Redline" })).toBeInTheDocument();
    expect(screen.getByText("Version abc1234")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Find a clause" })).toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "limitation of liability" });
    expect(
      screen.getAllByRole("button", { name: /./ }).filter((b) => b.className.includes("chip")),
    ).toHaveLength(3);

    fireEvent.click(chip);
    expect(screen.getByLabelText("Search contracts")).toHaveValue("limitation of liability");
    await waitFor(() => expect(calls("GET", "/search").length).toBeGreaterThan(0));
    const first = call("GET", "/search").url;
    expect(first.searchParams.get("q")).toBe("limitation of liability");
    expect(first.searchParams.get("expand")).toBe("false");
    expect(first.searchParams.get("limit")).toBe("20");
  });

  it("shows the no-results state", async () => {
    mockApi({ "GET /search": () => json(200, searchBody({})) });
    render(<App version="dev" />);
    search("indemnity unicorn");
    expect(await screen.findByRole("heading", { name: "No results" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing matches “indemnity unicorn”/)).toBeInTheDocument();
  });

  it("explains a search error and offers a retry", async () => {
    mockApi({
      "GET /search": () =>
        json(501, {
          error: "GET /search is not implemented yet",
          code: 501,
          details: { reason: "NOT_IMPLEMENTED" },
        }),
    });
    render(<App version="dev" />);
    search("fees");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/can't do that yet/);
    expect(within(alert).getByRole("button", { name: "Retry search" })).toBeInTheDocument();
  });

  it("renders plain results first, then merges expanded ones marked 'also matched'", async () => {
    let releaseExpanded: () => void = () => {};
    const expandedGate = new Promise<void>((r) => (releaseExpanded = r));
    mockApi({
      "GET /search": async (url) => {
        if (url.searchParams.get("expand") === "false") {
          return json(200, searchBody({ total: 1, results: [hit({})] }));
        }
        await expandedGate;
        return json(
          200,
          searchBody({
            total: 2,
            expansion: { status: "applied", added: ["cancel", "rescind"] },
            results: [
              hit({}),
              hit({
                start: 43,
                end: 80,
                snippet: "Either party may terminate on notice.",
                highlights: [],
                matchedTerms: ["terminate", "cancel", "rescind"],
              }),
            ],
          }),
        );
      },
    });
    render(<App version="dev" />);
    search("end the contract");

    expect(await screen.findByText(/is capped at six months/)).toBeInTheDocument();
    expect(screen.getByText(/expanding with synonyms/)).toBeInTheDocument();
    expect(screen.queryByText(/Either party may terminate/)).not.toBeInTheDocument();

    releaseExpanded();
    expect(await screen.findByText(/Either party may terminate/)).toBeInTheDocument();
    expect(screen.getByText("also matched: cancel, rescind")).toBeInTheDocument();
    expect(screen.queryByText(/expanding with synonyms/)).not.toBeInTheDocument();
    // The shared passage is shown once.
    expect(screen.getAllByText(/is capped at six months/)).toHaveLength(1);
    expect(screen.getAllByText(/also matched/)).toHaveLength(1);
  });

  it("shows a quiet chip when synonym expansion was skipped", async () => {
    mockApi({
      "GET /search": (url) =>
        json(
          200,
          searchBody({
            total: 1,
            results: [hit({})],
            expansion:
              url.searchParams.get("expand") === "true"
                ? { status: "skipped", added: [], reason: "quoted phrase" }
                : { status: "off", added: [] },
          }),
        ),
    });
    render(<App version="dev" />);
    search('"six months"');
    expect(await screen.findByText("synonyms skipped: quoted phrase")).toBeInTheDocument();
  });

  it("aborts the in-flight search when a new query is submitted", async () => {
    const signals: AbortSignal[] = [];
    mockApi({
      "GET /search": (_url, init) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise<Response>(() => {});
      },
    });
    render(<App version="dev" />);
    search("first");
    await waitFor(() => expect(signals).toHaveLength(1));
    search("second");
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  async function openFirstHit() {
    render(<App version="dev" />);
    search("liability");
    fireEvent.click(await screen.findByRole("button", { name: /SaaS MSA.*capped at six/s }));
    return screen.findByRole("region", { name: "Edit passage" });
  }

  it("previews with dryRun=true, applies with dryRun=false and reports the new version", async () => {
    const newText = TEXT.replace("six", "twelve");
    mockApi({
      "GET /search": () => json(200, searchBody({ total: 1, results: [hit({})] })),
      "PATCH /documents/msa": (url) => {
        const dryRun = url.searchParams.get("dryRun") === "true";
        return json(200, {
          id: "msa",
          version: dryRun ? 2 : 3,
          dryRun,
          text: newText,
          redline: [
            {
              changeIndex: 0,
              start: 23,
              end: 26,
              before: "Liability is capped at ",
              after: " months of fees.",
              segments: [
                { type: "delete", text: "six" },
                { type: "insert", text: "twelve" },
              ],
            },
          ],
        });
      },
    });
    const panel = await openFirstHit();
    // The document opens at the passage with it highlighted.
    expect(screen.getByTestId("doc-text").querySelector("mark")).toHaveTextContent(
      "Liability is capped at six months of fees.",
    );

    const box = within(panel).getByLabelText("Replacement");
    expect(box).toHaveValue("Liability is capped at six months of fees.");
    fireEvent.change(box, { target: { value: "Liability is capped at twelve months of fees." } });

    fireEvent.click(within(panel).getByRole("button", { name: "Preview" }));
    const del = await within(panel).findByText("six");
    expect(del.tagName).toBe("DEL");
    expect(within(panel).getByText("twelve").tagName).toBe("INS");

    const preview = call("PATCH", "/documents/msa", 0);
    expect(preview.url.searchParams.get("dryRun")).toBe("true");
    expect(preview.body).toEqual({
      changes: [
        {
          operation: "replace",
          target: { text: "Liability is capped at six months of fees.", occurrence: 1 },
          replacement: "Liability is capped at twelve months of fees.",
        },
      ],
    });

    fireEvent.click(within(panel).getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Applied 1 change. Now version 3.")).toBeInTheDocument();
    expect(call("PATCH", "/documents/msa", 1).url.searchParams.get("dryRun")).toBe("false");
    expect(screen.getByTestId("doc-text")).toHaveTextContent(newText);
    expect(screen.getByText("v3")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Edit passage" })).not.toBeInTheDocument();

    const events = vi
      .mocked(console.info)
      .mock.calls.map(([line]) => JSON.parse(line as string) as { event: string });
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["search", "preview", "apply"]),
    );
  });

  it("re-runs both search phases after Apply so result offsets match the new text", async () => {
    const newText = TEXT.replace("six", "twelve");
    let version = 2;
    mockApi({
      "GET /search": () =>
        json(
          200,
          searchBody({
            total: 1,
            results: [
              version === 2
                ? hit({})
                : hit({
                    docVersion: 3,
                    end: 45,
                    snippet: "Liability is capped at twelve months of fees.",
                    highlights: [],
                  }),
            ],
          }),
        ),
      "PATCH /documents/msa": () => {
        version = 3;
        return json(200, { id: "msa", version: 3, dryRun: false, text: newText, redline: [] });
      },
    });
    const panel = await openFirstHit();
    await waitFor(() => expect(calls("GET", "/search")).toHaveLength(2));
    fireEvent.change(within(panel).getByLabelText("Replacement"), {
      target: { value: "Liability is capped at twelve months of fees." },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Apply" }));

    expect(await screen.findByText("Applied 1 change. Now version 3.")).toBeInTheDocument();
    const fresh = await screen.findByRole("button", { name: /capped at twelve months/ });
    await waitFor(() => expect(calls("GET", "/search")).toHaveLength(4));
    const phases = calls("GET", "/search").map(([u]) =>
      new URL(u, "http://localhost").searchParams.get("expand"),
    );
    expect(phases).toEqual(["false", "true", "false", "true"]);

    // The refreshed hit carries the new offsets and opens the edit panel on the new text.
    fireEvent.click(fresh);
    const reopened = await screen.findByRole("region", { name: "Edit passage" });
    expect(within(reopened).getByLabelText("Replacement")).toHaveValue(
      "Liability is capped at twelve months of fees.",
    );
  });

  it("opens an outdated hit without a selection and says the passage may have moved", async () => {
    mockApi({
      "GET /search": () => json(200, searchBody({ total: 1, results: [hit({ docVersion: 1 })] })),
    });
    render(<App version="dev" />);
    search("liability");
    fireEvent.click(await screen.findByRole("button", { name: /SaaS MSA.*capped at six/s }));

    expect(
      await screen.findByText("This passage may have moved — search again."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("doc-text")).toHaveTextContent(TEXT);
    expect(screen.getByTestId("doc-text").querySelector("mark")).toBeNull();
    expect(screen.queryByRole("region", { name: "Edit passage" })).not.toBeInTheDocument();
  });

  it("runs phase 1 only when the Synonyms switch is off, remembers it, and re-runs on change", async () => {
    mockApi({
      "GET /search": (url) =>
        json(
          200,
          searchBody({
            total: 1,
            results: [hit({})],
            expansion:
              url.searchParams.get("expand") === "true"
                ? { status: "skipped", added: [], reason: "quoted phrase" }
                : { status: "off", added: [] },
          }),
        ),
    });
    render(<App version="dev" />);
    const toggle = screen.getByRole("switch", { name: "Synonyms" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveTextContent("On");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveTextContent("Off");
    expect(window.localStorage.getItem("redline.synonyms")).toBe("off");

    search("liability");
    expect(await screen.findByText(/is capped at six months/)).toBeInTheDocument();
    expect(screen.queryByText(/expanding with synonyms/)).not.toBeInTheDocument();
    expect(screen.queryByText(/synonyms skipped/)).not.toBeInTheDocument();
    const expands = () =>
      calls("GET", "/search").map(([u]) =>
        new URL(u, "http://localhost").searchParams.get("expand"),
      );
    expect(expands()).toEqual(["false"]);

    // Turning it on while results are shown re-runs the query with both phases.
    fireEvent.click(toggle);
    expect(await screen.findByText("synonyms skipped: quoted phrase")).toBeInTheDocument();
    expect(expands()).toEqual(["false", "false", "true"]);
    expect(window.localStorage.getItem("redline.synonyms")).toBe("on");
  });

  it("starts with Synonyms off when that was saved, and on when storage is unavailable", () => {
    mockApi({});
    window.localStorage.setItem("redline.synonyms", "off");
    const { unmount } = render(<App version="dev" />);
    expect(screen.getByRole("switch", { name: "Synonyms" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    unmount();

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<App version="dev" />);
    expect(screen.getByRole("switch", { name: "Synonyms" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("opens the edit panel on a keyboard selection when Shift is released", async () => {
    mockApi({});
    render(<App version="dev" />);
    await screen.findByRole("option", { name: "SaaS MSA" });
    fireEvent.change(screen.getByRole("combobox", { name: "Document" }), {
      target: { value: "msa" },
    });
    const pre = await screen.findByTestId("doc-text");
    const textNode = pre.firstChild;
    if (!textNode) throw new Error("no text node");

    // Shift+arrows extend a selection over "six months".
    const range = document.createRange();
    range.setStart(textNode, 23);
    range.setEnd(textNode, 33);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.keyUp(pre, { key: "ArrowRight", shiftKey: true });
    expect(screen.queryByRole("region", { name: "Edit passage" })).not.toBeInTheDocument();

    fireEvent.keyUp(pre, { key: "Shift" });
    const panel = await screen.findByRole("region", { name: "Edit passage" });
    expect(within(panel).getByLabelText("Replacement")).toHaveValue("six months");
    expect(pre.querySelector("mark")).toHaveTextContent("six months");
    selection?.removeAllRanges();
  });

  it("says Claude is unavailable when suggestions return 503", async () => {
    mockApi({
      "GET /search": () => json(200, searchBody({ total: 1, results: [hit({})] })),
      "POST /documents/msa/suggestions": () =>
        json(503, { error: "LLM unavailable", code: 503, details: { reason: "LLM_UNAVAILABLE" } }),
    });
    const panel = await openFirstHit();
    fireEvent.change(within(panel).getByLabelText("Instruction for Claude (optional)"), {
      target: { value: "make it twelve months" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Suggest" }));
    expect(
      await within(panel).findByText("Claude unavailable — write the change yourself"),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Suggest" })).not.toBeInTheDocument();
    expect(call("POST", "/documents/msa/suggestions").body).toEqual({
      range: { start: 0, end: 42 },
      instruction: "make it twelve months",
    });
  });

  it("fills the replacement from a Claude suggestion", async () => {
    mockApi({
      "GET /search": () => json(200, searchBody({ total: 1, results: [hit({})] })),
      "POST /documents/msa/suggestions": () =>
        json(200, {
          replacement: "Liability is capped at twelve months of fees.",
          rationale: "Raises the cap.",
          model: "m",
        }),
    });
    const panel = await openFirstHit();
    fireEvent.click(within(panel).getByRole("button", { name: "Suggest" }));
    expect(await within(panel).findByText("Claude: Raises the cap.")).toBeInTheDocument();
    expect(within(panel).getByLabelText("Replacement")).toHaveValue(
      "Liability is capped at twelve months of fees.",
    );
  });

  it("offers to reload the document when the target passage changed", async () => {
    mockApi({
      "GET /search": () => json(200, searchBody({ total: 1, results: [hit({})] })),
      "PATCH /documents/msa": () =>
        json(422, {
          error: "target not found",
          code: 422,
          details: { reason: "TARGET_NOT_FOUND" },
        }),
    });
    const panel = await openFirstHit();
    fireEvent.change(within(panel).getByLabelText("Replacement"), { target: { value: "x" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Preview" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent(/passage changed/);
    const before = calls("GET", "/documents/msa").length;
    fireEvent.click(within(alert).getByRole("button", { name: "Reload document" }));
    await waitFor(() => expect(calls("GET", "/documents/msa").length).toBe(before + 1));
  });

  it("sends If-Match with the loaded version and offers a reload on 412", async () => {
    mockApi({
      "GET /search": () => json(200, searchBody({ total: 1, results: [hit({})] })),
      "PATCH /documents/msa": () =>
        json(412, {
          error: "the document changed since this version",
          code: 412,
          details: { reason: "VERSION_CONFLICT", currentVersion: 3 },
        }),
    });
    const panel = await openFirstHit();
    fireEvent.change(within(panel).getByLabelText("Replacement"), { target: { value: "x" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Apply" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("This document changed since you opened it.");

    const headers = calls("PATCH", "/documents/msa")[0]?.[1]?.headers as Record<string, string>;
    expect(headers["If-Match"]).toBe('"v2"');

    const before = calls("GET", "/documents/msa").length;
    fireEvent.click(within(alert).getByRole("button", { name: "Reload document" }));
    await waitFor(() => expect(calls("GET", "/documents/msa").length).toBe(before + 1));
  });
});

describe("home state", () => {
  const library = [
    { id: "msa", title: "SaaS MSA", version: 2, length: 12345 },
    { id: "nda", title: "Mutual NDA", version: 1, length: 1 },
  ];

  it("lists every document with its length and version, beside the example chips", async () => {
    mockApi({ "GET /documents": () => json(200, { documents: library }) });
    render(<App version="dev" />);
    const list = await screen.findByRole("list", { name: "All documents" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([
      "SaaS MSA12,345 characters · v2",
      "Mutual NDA1 character · v1",
    ]);
    expect(screen.getByRole("button", { name: "limitation of liability" })).toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: /SaaS MSA/ }));
    expect(await screen.findByTestId("doc-text")).toHaveTextContent(TEXT);
    // The version sits next to the title at the top of the document.
    expect(screen.getByRole("heading", { name: "SaaS MSA" }).nextElementSibling).toHaveTextContent(
      "v2",
    );
  });

  it("says so when no documents are loaded", async () => {
    mockApi({ "GET /documents": () => json(200, { documents: [] }) });
    render(<App version="dev" />);
    expect(await screen.findByText("No documents loaded.")).toBeInTheDocument();
  });
});

describe("clearing the search", () => {
  const expanded = (url: URL) =>
    json(
      200,
      searchBody({
        total: 1,
        results: [hit({})],
        documents: [{ docId: "msa", title: "SaaS MSA", passages: 1 }],
        expansion:
          url.searchParams.get("expand") === "true"
            ? { status: "applied", added: ["cap"] }
            : { status: "off", added: [] },
      }),
    );

  it("the clear button empties the box and returns to the home state", async () => {
    mockApi({ "GET /search": expanded });
    render(<App version="dev" />);
    search("liability");
    expect(await screen.findByText("Also searching:")).toBeInTheDocument();

    const input = screen.getByLabelText("Search contracts");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Find a clause" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Search results" })).not.toBeInTheDocument();
    expect(screen.queryByText("Also searching:")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
  });

  it("emptying the box by typing clears the search and aborts one in flight", async () => {
    const signals: AbortSignal[] = [];
    mockApi({
      "GET /search": (url, init) => {
        if (url.searchParams.get("q") === "pending") {
          if (init?.signal) signals.push(init.signal);
          return new Promise<Response>(() => {});
        }
        return expanded(url);
      },
    });
    render(<App version="dev" />);
    search("liability");
    expect(await screen.findByText(/is capped at six months/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search contracts"), { target: { value: "" } });
    expect(screen.getByRole("heading", { name: "Find a clause" })).toBeInTheDocument();
    expect(screen.queryByText(/is capped at six months/)).not.toBeInTheDocument();

    search("pending");
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Search contracts"), { target: { value: "" } });
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.getByRole("heading", { name: "Find a clause" })).toBeInTheDocument();
  });
});

describe("closing the document", () => {
  it("clears the selection and edit panel but keeps the search results", async () => {
    mockApi({
      "GET /search": () =>
        json(
          200,
          searchBody({
            total: 1,
            results: [hit({})],
            documents: [{ docId: "msa", title: "SaaS MSA", passages: 1 }],
          }),
        ),
    });
    render(<App version="dev" />);
    expect(screen.queryByRole("button", { name: "Close document" })).not.toBeInTheDocument();
    search("liability");
    fireEvent.click(await screen.findByRole("button", { name: /SaaS MSA.*capped at six/s }));
    expect(await screen.findByRole("region", { name: "Edit passage" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    expect(screen.queryByTestId("doc-text")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Edit passage" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No document open" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Document" })).toHaveValue("");
    // The search stays, with no result marked as open.
    const hitRow = screen.getByRole("button", { name: /SaaS MSA.*capped at six/s });
    expect(hitRow).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("button", { name: "Close document" })).not.toBeInTheDocument();
  });

  it("returns to the home list when no search is active", async () => {
    mockApi({});
    render(<App version="dev" />);
    const list = await screen.findByRole("list", { name: "All documents" });
    fireEvent.click(within(list).getByRole("button", { name: /SaaS MSA/ }));
    await screen.findByTestId("doc-text");
    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    expect(screen.queryByTestId("doc-text")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "All documents" })).toBeInTheDocument();
  });
});

describe("result counts", () => {
  it("heads the passages with totals and lists matching documents by count", async () => {
    mockApi({
      "GET /documents/nda": () =>
        json(200, { id: "nda", title: "Mutual NDA", text: "Confidential.", version: 1 }),
      "GET /search": () =>
        json(
          200,
          searchBody({
            total: 30,
            results: [hit({})],
            documents: [
              { docId: "msa", title: "SaaS MSA", passages: 29 },
              { docId: "nda", title: "Mutual NDA", passages: 1 },
            ],
          }),
        ),
    });
    render(<App version="dev" />);
    search("liability");
    expect(
      await screen.findByRole("heading", { name: /^30 passages across 2 documents/ }),
    ).toHaveTextContent("30 passages across 2 documents · showing 1");
    const docs = screen.getByRole("list", { name: "Matching documents" });
    expect(
      within(docs)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["SaaS MSA29 passages", "Mutual NDA1 passage"]);

    fireEvent.click(within(docs).getByRole("button", { name: /Mutual NDA/ }));
    expect(await screen.findByTestId("doc-text")).toHaveTextContent("Confidential.");
    expect(screen.queryByRole("region", { name: "Edit passage" })).not.toBeInTheDocument();
  });

  it("uses the singular for one passage in one document", async () => {
    mockApi({
      "GET /search": () =>
        json(
          200,
          searchBody({
            total: 1,
            results: [hit({})],
            documents: [{ docId: "msa", title: "SaaS MSA", passages: 1 }],
          }),
        ),
    });
    render(<App version="dev" />);
    search("liability");
    const heading = await screen.findByRole("heading", { name: /across/ });
    expect(heading).toHaveTextContent(/^1 passage across 1 document$/);
  });

  it("takes the counts from the latest completed phase", async () => {
    let releaseExpanded: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseExpanded = r));
    mockApi({
      "GET /search": async (url) => {
        if (url.searchParams.get("expand") === "false") {
          return json(
            200,
            searchBody({
              total: 1,
              results: [hit({})],
              documents: [{ docId: "msa", title: "SaaS MSA", passages: 1 }],
            }),
          );
        }
        await gate;
        return json(
          200,
          searchBody({
            total: 3,
            expansion: { status: "applied", added: ["cap"] },
            results: [hit({})],
            documents: [
              { docId: "nda", title: "Mutual NDA", passages: 2 },
              { docId: "msa", title: "SaaS MSA", passages: 1 },
            ],
          }),
        );
      },
    });
    render(<App version="dev" />);
    search("liability");
    expect(
      await screen.findByRole("heading", { name: "1 passage across 1 document" }),
    ).toBeInTheDocument();
    releaseExpanded();
    expect(
      await screen.findByRole("heading", { name: /^3 passages across 2 documents/ }),
    ).toBeInTheDocument();
    const docs = screen.getByRole("list", { name: "Matching documents" });
    expect(
      within(docs)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Mutual NDA2 passages", "SaaS MSA1 passage"]);
  });

  it("keeps the first-phase counts when expansion fails", async () => {
    mockApi({
      "GET /search": (url) =>
        url.searchParams.get("expand") === "true"
          ? json(500, { error: "boom", code: 500, details: { reason: "INTERNAL" } })
          : json(
              200,
              searchBody({
                total: 2,
                results: [hit({}), hit({ start: 43, end: 80 })],
                documents: [{ docId: "msa", title: "SaaS MSA", passages: 2 }],
              }),
            ),
    });
    render(<App version="dev" />);
    search("liability");
    expect(await screen.findByText("synonyms unavailable")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "2 passages across 1 document" }),
    ).toBeInTheDocument();
  });
});

describe("synonyms under the search box", () => {
  it("lists the added synonyms as chips once expansion is applied", async () => {
    let releaseExpanded: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseExpanded = r));
    mockApi({
      "GET /search": async (url) => {
        if (url.searchParams.get("expand") === "false") {
          return json(200, searchBody({ total: 1, results: [hit({})] }));
        }
        await gate;
        return json(
          200,
          searchBody({
            total: 1,
            results: [hit({})],
            expansion: { status: "applied", added: ["cancel", "rescind", "end"] },
          }),
        );
      },
    });
    render(<App version="dev" />);
    const line = screen.getByTestId("synonym-line");
    expect(line).toBeEmptyDOMElement();
    search("terminate");
    // Phase 2 running: the indicator holds the same spot.
    expect(await within(line).findByText(/expanding with synonyms/)).toBeInTheDocument();
    releaseExpanded();
    const chips = await within(line).findByRole("list", { name: "Also searching:" });
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["cancel", "rescind", "end"]);
    expect(line).toHaveTextContent("Also searching:cancelrescindend");
    expect(within(line).queryByText(/expanding with synonyms/)).not.toBeInTheDocument();
    expect(screen.queryByText(/synonyms$/)).not.toBeInTheDocument();
  });

  it("keeps the skipped chip, and shows nothing when Synonyms is off", async () => {
    mockApi({
      "GET /search": (url) =>
        json(
          200,
          searchBody({
            total: 1,
            results: [hit({})],
            expansion:
              url.searchParams.get("expand") === "true"
                ? { status: "skipped", added: [], reason: "quoted phrase" }
                : { status: "off", added: [] },
          }),
        ),
    });
    render(<App version="dev" />);
    search(`"six months"`);
    const line = screen.getByTestId("synonym-line");
    expect(await within(line).findByText("synonyms skipped: quoted phrase")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Synonyms" }));
    await waitFor(() => expect(calls("GET", "/search")).toHaveLength(3));
    expect(await screen.findByText(/is capped at six months/)).toBeInTheDocument();
    expect(line).toBeEmptyDOMElement();
  });
});
