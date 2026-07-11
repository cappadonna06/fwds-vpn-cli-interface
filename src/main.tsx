import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

function mount() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

if (import.meta.env.DEV) {
  // Dev-only: let the UI boot in a plain browser when Tauri is absent.
  import("./dev/browserTauriShim")
    .then((m) => m.installBrowserTauriShim())
    .finally(mount);
} else {
  mount();
}
