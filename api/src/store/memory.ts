import { randomUUID } from "node:crypto";
import type {
  ChangeListener,
  ChangeLogEntry,
  ChangeOp,
  Document,
  DocumentStore,
  DocumentSummary,
} from "../domain/types.js";

interface Entry {
  doc: Document;
  history: ChangeLogEntry[];
}

export class InMemoryDocumentStore implements DocumentStore {
  private readonly docs = new Map<string, Entry>();
  private readonly listeners = new Set<ChangeListener>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  list(): DocumentSummary[] {
    return [...this.docs.values()].map(({ doc }) => ({
      id: doc.id,
      title: doc.title,
      version: doc.version,
      length: doc.text.length,
    }));
  }

  get(id: string): Document | undefined {
    const entry = this.docs.get(id);
    return entry ? { ...entry.doc } : undefined;
  }

  create(input: { title: string; text: string; id?: string }): Document {
    const id = input.id ?? randomUUID();
    if (this.docs.has(id)) throw new Error(`document ${id} already exists`);
    const doc: Document = { id, title: input.title, text: input.text, version: 1 };
    this.docs.set(id, { doc, history: [] });
    return { ...doc };
  }

  commit(id: string, newText: string, ops: ChangeOp[]): Document {
    const entry = this.docs.get(id);
    if (!entry) throw new Error(`document ${id} not found`);
    const version = entry.doc.version + 1;
    entry.doc = { ...entry.doc, text: newText, version };
    entry.history.push({
      version,
      appliedAt: this.now().toISOString(),
      ops: ops.map((op) => ({ ...op })),
    });
    for (const listener of this.listeners) listener({ id, version, ops });
    return { ...entry.doc };
  }

  history(id: string): ChangeLogEntry[] | undefined {
    return this.docs.get(id)?.history.map((h) => ({ ...h, ops: [...h.ops] }));
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
