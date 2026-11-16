import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App", () => {
  it("renders the title, a disabled search box and the version", () => {
    render(<App version="abc1234" />);
    expect(screen.getByRole("heading", { name: "Redline" })).toBeInTheDocument();
    const input = screen.getByLabelText("Search contracts");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("placeholder", "Search coming soon");
    expect(screen.getByText("Version abc1234")).toBeInTheDocument();
  });
});
