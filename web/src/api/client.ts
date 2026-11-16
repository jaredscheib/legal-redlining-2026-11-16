import type {
  DocumentBody,
  DocumentSummary,
  ErrorBody,
  PatchDocumentResponse,
  ReplaceChange,
  SearchResponse,
  SuggestionResponse,
} from "./types";

/** A failed request. `status` is 0 when the server could not be reached. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

async function request<T>(
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = {},
): Promise<T> {
  let res: Response;
  try {
    const all = init.body ? { "content-type": "application/json", ...headers } : headers;
    res = await fetch(path, {
      ...init,
      headers: Object.keys(all).length ? all : undefined,
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiFailure(0, "NETWORK", "Could not reach the server");
  }
  if (!res.ok) {
    let body: Partial<ErrorBody> = {};
    try {
      body = (await res.json()) as ErrorBody;
    } catch {
      // Non-JSON error body (e.g. a proxy page); fall back to the status alone.
    }
    throw new ApiFailure(
      res.status,
      body.details?.reason ?? "HTTP_ERROR",
      body.error ?? `Request failed with status ${res.status}`,
    );
  }
  return (await res.json()) as T;
}

export function listDocuments(signal?: AbortSignal) {
  return request<{ documents: DocumentSummary[] }>("/documents", { signal });
}

export function getDocument(id: string, signal?: AbortSignal) {
  return request<DocumentBody>(`/documents/${encodeURIComponent(id)}`, { signal });
}

export const SEARCH_LIMIT = 20;

export function search(q: string, expand: boolean, signal?: AbortSignal) {
  const params = new URLSearchParams({
    q,
    limit: String(SEARCH_LIMIT),
    offset: "0",
    expand: String(expand),
  });
  return request<SearchResponse>(`/search?${params.toString()}`, { signal });
}

/** The server's ETag for a document version: `"v<version>"`. */
export const etag = (version: number) => `"v${version}"`;

/**
 * Previews or applies one change. With `version`, sends `If-Match: etag(version)` so the
 * server answers 412 VERSION_CONFLICT if the document changed since it was loaded.
 */
export function patchDocument(
  id: string,
  change: ReplaceChange,
  dryRun: boolean,
  version?: number,
) {
  return request<PatchDocumentResponse>(
    `/documents/${encodeURIComponent(id)}?dryRun=${String(dryRun)}`,
    { method: "PATCH", body: JSON.stringify({ changes: [change] }) },
    version === undefined ? {} : { "If-Match": etag(version) },
  );
}

export const isVersionConflict = (err: unknown) =>
  err instanceof ApiFailure && err.status === 412 && err.reason === "VERSION_CONFLICT";

export function suggest(id: string, range: { start: number; end: number }, instruction?: string) {
  return request<SuggestionResponse>(`/documents/${encodeURIComponent(id)}/suggestions`, {
    method: "POST",
    body: JSON.stringify(instruction ? { range, instruction } : { range }),
  });
}

/** Claude is unavailable when the suggestions route answers 502 or 503. */
export const isClaudeUnavailable = (err: unknown) =>
  err instanceof ApiFailure && [502, 503].includes(err.status);

/** What happened and what to do, for an error shown to the lawyer. */
export function describeError(err: unknown, action: string): string {
  if (!(err instanceof ApiFailure)) return `Something went wrong while ${action}. Try again.`;
  if (err.status === 0) {
    return `Couldn't reach the server while ${action}. Check your connection or that the server is running, then try again.`;
  }
  if (err.status >= 500) {
    return `The server hit an error while ${action} (${err.status}). Try again in a moment.`;
  }
  if (err.status === 404) return `${err.message}. It may have been removed; reload the page.`;
  return `${err.message} (${err.status}). Adjust your input and try again.`;
}
