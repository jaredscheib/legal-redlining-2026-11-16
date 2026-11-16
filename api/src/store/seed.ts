import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../config.js";
import type { DocumentStore } from "../domain/types.js";

export interface SeedFile {
  /** File name without extension; used as the document id. */
  id: string;
  title: string;
  text: string;
}

/** Reads `<dir>/*.txt`, sorted by name. The title is the first non-empty line. */
export function readSeedFiles(dir: string = PATHS.seedDir): SeedFile[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((file) => {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      const title = text.split("\n").find((l) => l.trim() !== "") ?? file;
      return { id: path.basename(file, ".txt"), title: title.trim(), text };
    });
}

export function seedStore(store: DocumentStore, dir?: string): number {
  const files = readSeedFiles(dir);
  for (const f of files) store.create(f);
  return files.length;
}
