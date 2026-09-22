import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("Application root was not found.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
