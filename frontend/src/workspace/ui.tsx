import React from "react";
import { Loader2 } from "lucide-react";

// Workspace routes live under #/workspace/; `path` is what follows it.
export const go = (path: string) => {
  window.location.hash = "/workspace/" + path;
  window.scrollTo({ top: 0, behavior: "instant" });
};
export const orderPath = (id: string) => "orders/" + encodeURIComponent(id);
export const initialsOf = (text: string) =>
  text
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
export const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;
export const listNames = (names: string[]) =>
  names.length > 2
    ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
    : names.join(" and ");
export const download = (name: string, content: string, type = "text/csv") => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export type Notify = (text: string, error?: boolean) => void;
export const Button = ({
  children,
  onClick,
  kind = "",
  disabled = false,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  kind?: string;
  disabled?: boolean;
  type?: "button" | "submit";
}) => (
  <button
    type={type}
    className={`btn ${kind}`}
    onClick={onClick}
    disabled={disabled}
  >
    {children}
  </button>
);
export function PageHeading({
  label,
  title,
  description,
  action,
}: {
  label: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="page-heading">
      <div>
        <span className="eyebrow">{label}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </section>
  );
}
export const Loading = ({
  children,
  icon = false,
}: {
  children: React.ReactNode;
  icon?: boolean;
}) => (
  <section className="panel" role="status">
    {icon && (
      <>
        <Loader2 size={20} />{" "}
      </>
    )}
    {children}
  </section>
);
