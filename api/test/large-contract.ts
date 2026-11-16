import { readSeedFiles } from "../src/store/seed.js";

export const TEN_MB = 10 * 1024 * 1024;

/** Concatenates renumbered seed clauses until the text exceeds `minChars`. */
export function buildLargeContract(minChars: number): string {
  const clauses = readSeedFiles().flatMap((f) =>
    f.text.split(/\n(?=\d+\. )/).filter((c) => /^\d+\. /.test(c)),
  );
  const parts: string[] = ["Consolidated Master Agreement\n"];
  let size = parts[0]?.length ?? 0;
  for (let n = 1; size <= minChars; n++) {
    const clause = clauses[(n - 1) % clauses.length] ?? "";
    const renumbered = clause.replace(/^\d+\./, `${n}.`) + "\n";
    parts.push(renumbered);
    size += renumbered.length;
  }
  return parts.join("");
}
