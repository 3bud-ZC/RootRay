import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AppProvider } from "./state/store";
import "./index.css";

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");

createRoot(el).render(
  <StrictMode>
    <AppProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </AppProvider>
  </StrictMode>,
);

// The branded splash covers bootstrap only — drop it once React has
// painted; startup gets no artificial delay.
requestAnimationFrame(() => document.getElementById("boot-splash")?.remove());
