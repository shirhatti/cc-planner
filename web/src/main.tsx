import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./components/App";
import { sessionStore } from "./session-store";
import "./styles.css";

registerSW({ immediate: true });
sessionStore.connect();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
