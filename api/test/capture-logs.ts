import { vi } from "vitest";

export interface Captured {
  /** Raw JSONL lines written to stdout. */
  raw: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events: any[];
}

/** Runs `fn` with LOG_STDOUT on and returns every log line it wrote, parsed. */
export async function captureLogs(fn: () => Promise<unknown>): Promise<Captured> {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const prev = process.env.LOG_STDOUT;
  process.env.LOG_STDOUT = "on";
  try {
    await fn();
    const raw = write.mock.calls.map((c) => String(c[0]));
    const events = raw.flatMap((l) => l.split("\n").filter(Boolean)).map((l) => JSON.parse(l));
    return { raw, events };
  } finally {
    process.env.LOG_STDOUT = prev;
    write.mockRestore();
  }
}
