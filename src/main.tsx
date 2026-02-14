import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { logFrontendError } from "./lib/diagnostics";

window.addEventListener("error", (event) => {
  void logFrontendError("Unhandled window error", event.error ?? event.message, {
    level: "error",
    context: `${event.filename}:${event.lineno}:${event.colno}`,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  void logFrontendError("Unhandled promise rejection", event.reason, {
    level: "error",
  });
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
