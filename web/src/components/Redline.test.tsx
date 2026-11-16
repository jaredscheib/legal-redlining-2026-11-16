import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Redline } from "./Redline";

describe("Redline", () => {
  it("renders context, deletions as <del>, insertions as <ins> and equal text plain", () => {
    render(
      <Redline
        hunk={{
          changeIndex: 0,
          start: 10,
          end: 30,
          before: "capped at ",
          after: " of fees.",
          segments: [
            { type: "equal", text: "the " },
            { type: "delete", text: "six" },
            { type: "insert", text: "twelve" },
            { type: "equal", text: " months" },
          ],
        }}
      />,
    );
    const p = screen.getByTestId("redline");
    expect(p).toHaveTextContent("capped at the sixtwelve months of fees.");

    const del = screen.getByText("six");
    expect(del.tagName).toBe("DEL");
    expect(del).toHaveClass("redline-del");

    const ins = screen.getByText("twelve");
    expect(ins.tagName).toBe("INS");
    expect(ins).toHaveClass("redline-ins");

    expect(screen.getByText("the").tagName).toBe("SPAN");
    expect(p.querySelectorAll("del")).toHaveLength(1);
    expect(p.querySelectorAll("ins")).toHaveLength(1);
    expect(screen.getByText("capped at")).toHaveClass("redline-context");
  });
});
