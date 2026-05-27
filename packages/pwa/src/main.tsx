import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

// Optional OTel chunk. Only loaded when VITE_OTEL_ENABLED=1 — keeps the
// regular bundle slim. Top-level await is supported by Vite/ESM.
if (import.meta.env.VITE_OTEL_ENABLED === "1") {
  // Don't block render on the chunk; load in parallel and wire up runtime
  // when ready. Spans before init are silently dropped (no-op).
  void (async () => {
    const otel = await import("./otel/index.ts");
    const collectorUrl =
      (import.meta.env.VITE_OTEL_COLLECTOR_URL as string | undefined) ??
      "http://localhost:4318";
    otel.initWebOtel({ collectorUrl });
    const { installRuntime } = await import("./otel/runtime.ts");
    installRuntime({
      startUserSpan: otel.startUserSpan,
      recordRenderSpan: otel.recordRenderSpan,
    });
  })();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
