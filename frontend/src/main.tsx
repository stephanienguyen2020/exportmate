import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import Landing from "./Landing";
import AccountPage from "./Account";
import { hasSession } from "./account-store";
import ChatPage, { ChatWidget } from "../ai/chat/Chat";
import ErrorBoundary from "./ErrorBoundary";
import Workspace from "./workspace/Workspace";
function Root() {
  const action = new URLSearchParams(location.search).get("mode");
  useEffect(() => {
    if (action === "resetPassword") location.hash = "/reset-password";
    if (action === "verifyEmail") location.hash = "/verify-email";
  }, [action]);
  const [fullPath, setPath] = useState(location.hash.replace(/^#\/?/, ""));
  const path = fullPath.split("?")[0];
  const section =
    new URLSearchParams(fullPath.split("?")[1] || "").get("section") || "";
  const workspace =
    path === "workspace" ||
    path.startsWith("workspace/") ||
    /^(orders|map|news|rules|regulations|reports|data|playbook)(\/|$)/.test(path);
  useEffect(() => {
    const update = () => {
      const value = location.hash.replace(/^#\/?/, "");
      setPath(value);
      if (!value.startsWith("?section=")) window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    if (workspace && !hasSession()) {
      try {
        sessionStorage.setItem(
          "em-next",
          path.startsWith("workspace") ? path : "workspace/" + path,
        );
      } catch {}
      location.hash = "/login";
    }
  }, [path, workspace]);
  if (path === "chat")
    return (
      <ErrorBoundary>
        <ChatPage />
      </ErrorBoundary>
    );
  return (
    <>
      <ErrorBoundary resetKey={path}>
        {path === "" ? (
          <Landing section={section} />
        ) : workspace ? (
          hasSession() ? (
            <Workspace />
          ) : null
        ) : (
          <AccountPage route={path} />
        )}
      </ErrorBoundary>
      {/* Not on sign-in and account pages, where it covered the forms. */}
      {(path === "" || workspace) && (
        <ErrorBoundary fallback={null}>
          <ChatWidget />
        </ErrorBoundary>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
