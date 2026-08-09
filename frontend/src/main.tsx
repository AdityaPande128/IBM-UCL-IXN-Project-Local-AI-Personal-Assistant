import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { OverlayBar } from "./components/OverlayBar";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

function windowLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "main";
  }
}

const isOverlay = windowLabel() === "overlay";
if (isOverlay) document.body.classList.add("overlay-body");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isOverlay ? <OverlayBar /> : <App />}</React.StrictMode>,
);
