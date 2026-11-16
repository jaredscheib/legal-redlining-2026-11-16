import type { LlmService } from "../domain/types.js";
import type { LlmClient } from "./client.js";
import { createExpander } from "./expand.js";
import { createSuggester } from "./suggest.js";

/** Query expansion on EXPANSION_MODEL and suggestions on SUGGESTION_MODEL, over one client. */
export function createLlmService(client: LlmClient): LlmService {
  return { expand: createExpander(client), suggest: createSuggester(client) };
}
