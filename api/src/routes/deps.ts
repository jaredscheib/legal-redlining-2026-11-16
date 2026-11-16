import type { Hono } from "hono";
import type { DocumentStore, LlmService, SearchService } from "../domain/types.js";

export interface AppDeps {
  store: DocumentStore;
  search: SearchService;
  llm: LlmService;
}

export type Registrar = (app: Hono, deps: AppDeps) => void;
