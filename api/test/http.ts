/** Shared helpers for tests that drive the app through `createApp(...).request()`. */
import { expect } from "vitest";
import { createApp } from "../src/app.js";
import type { LlmService, SearchService } from "../src/domain/types.js";
import type { ErrorBody } from "../src/errors.js";
import type { AppDeps } from "../src/routes/deps.js";
import { InMemoryDocumentStore } from "../src/store/memory.js";

/** A request with a JSON body. */
export const jsonInit = (
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

/** Tests poke at response JSON freely; the shapes are asserted, not trusted. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const readJson = (res: Response) => res.json() as Promise<any>;

/** Asserts the error body shape: a message, `code`, and optionally `details.reason`. */
export function expectError(body: ErrorBody, code: number, reason?: string) {
  expect(typeof body.error).toBe("string");
  expect(body.code).toBe(code);
  if (reason) expect(body.details?.reason).toBe(reason);
}

/** Answers every query with no results. */
export const fakeSearch: SearchService = {
  search: async (q) => ({
    query: q.q,
    terms: [],
    phrases: [],
    expansion: { status: "off", added: [] },
    total: 0,
    results: [],
    documents: [],
  }),
};

/** Never expands; suggests the passage unchanged. */
export const fakeLlm: LlmService = {
  expand: async () => ({ added: [] }),
  suggest: async ({ text }) => ({ replacement: text, rationale: "Unchanged.", model: "fake" }),
};

/** The app over an empty store and fake search and LLM services, unless `deps` overrides them. */
export const appWith = (deps: Partial<AppDeps> = {}) =>
  createApp({ store: new InMemoryDocumentStore(), search: fakeSearch, llm: fakeLlm, ...deps });
