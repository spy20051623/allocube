import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { initializeI18n } from "./i18n";
import "./styles.css";

await initializeI18n();
const content = React.createElement(RouterProvider, {
  router: (await import("./router")).router,
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{content}</React.StrictMode>,
);
