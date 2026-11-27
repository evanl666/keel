import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

async function boot() {
  if (import.meta.env.VITE_MOCK === "1") {
    const mock = await import("./api/mock");
    mock.installMock();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
