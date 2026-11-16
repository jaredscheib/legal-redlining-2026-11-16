/**
 * Builds the production dependency graph. The server and the evals runner share it, so the
 * evals measure exactly what the server would serve.
 */
import type { AppDeps } from "./routes/deps.js";
import { createLlmClient, type LlmClient } from "./llm/client.js";
import { InMemoryDocumentStore } from "./store/memory.js";
import { seedStore } from "./store/seed.js";

export interface Runtime {
  deps: AppDeps;
  llmClient: LlmClient;
  seeded: number;
}

export function createRuntime(opts: { llmClient?: LlmClient } = {}): Runtime {
  const store = new InMemoryDocumentStore();
  const seeded = seedStore(store);
  const llmClient = opts.llmClient ?? createLlmClient();
  // Search and LLM services land in later tickets; until then their routes answer 501.
  return { deps: { store }, llmClient, seeded };
}
