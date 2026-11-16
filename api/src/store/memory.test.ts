import { describe, expect, it, vi } from "vitest";
import { InMemoryDocumentStore } from "./memory.js";
import { readSeedFiles } from "./seed.js";

describe("InMemoryDocumentStore", () => {
  const fixedNow = () => new Date("2026-11-16T12:00:00Z");

  it("creates documents at version 1 and lists them", () => {
    const store = new InMemoryDocumentStore();
    const doc = store.create({ title: "T", text: "abc" });
    expect(doc.version).toBe(1);
    expect(store.list()).toEqual([{ id: doc.id, title: "T", version: 1, length: 3 }]);
  });

  it("rejects a duplicate id", () => {
    const store = new InMemoryDocumentStore();
    store.create({ id: "x", title: "T", text: "abc" });
    expect(() => store.create({ id: "x", title: "T", text: "abc" })).toThrow();
  });

  it("commit bumps the version, replaces the text and appends to history", () => {
    const store = new InMemoryDocumentStore(fixedNow);
    const { id } = store.create({ title: "T", text: "may cancel" });
    const op = { start: 4, end: 10, oldText: "cancel", newText: "terminate" };
    const next = store.commit(id, "may terminate", [op]);
    expect(next).toMatchObject({ text: "may terminate", version: 2 });
    expect(store.get(id)?.version).toBe(2);
    expect(store.history(id)).toEqual([
      { version: 2, appliedAt: "2026-11-16T12:00:00.000Z", ops: [op] },
    ]);
  });

  it("commit throws for an unknown id", () => {
    expect(() => new InMemoryDocumentStore().commit("nope", "x", [])).toThrow();
  });

  it("notifies onChange listeners and supports unsubscribe", () => {
    const store = new InMemoryDocumentStore();
    const { id } = store.create({ title: "T", text: "a" });
    const listener = vi.fn();
    const off = store.onChange(listener);
    store.commit(id, "b", []);
    expect(listener).toHaveBeenCalledWith({ id, version: 2, ops: [] });
    off();
    store.commit(id, "c", []);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("returns copies, so callers cannot mutate stored state", () => {
    const store = new InMemoryDocumentStore();
    const { id } = store.create({ title: "T", text: "a" });
    const got = store.get(id);
    if (!got) throw new Error("missing");
    got.text = "mutated";
    expect(store.get(id)?.text).toBe("a");
  });
});

describe("seed", () => {
  it("loads 4 contracts of 60-150 lines with the first line as title", () => {
    const files = readSeedFiles();
    expect(files.map((f) => f.id)).toEqual([
      "commercial-lease",
      "employment-agreement",
      "mutual-nda",
      "saas-msa",
    ]);
    for (const f of files) {
      const lines = f.text.trimEnd().split("\n").length;
      expect(lines).toBeGreaterThanOrEqual(60);
      expect(lines).toBeLessThanOrEqual(150);
      expect(f.text.startsWith(f.title)).toBe(true);
    }
  });
});
