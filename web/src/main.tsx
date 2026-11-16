import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { VERSION } from "./version";

console.info(JSON.stringify({ event: "app.start", version: VERSION }));

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App version={VERSION} />
  </StrictMode>,
);
