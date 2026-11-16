import { createApp } from "../src/app.js";
import type { LlmService, SearchService } from "../src/domain/types.js";
import type { AppDeps } from "../src/routes/deps.js";
import { InMemoryDocumentStore } from "../src/store/memory.js";

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
