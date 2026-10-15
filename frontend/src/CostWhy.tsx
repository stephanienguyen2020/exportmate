// A calculated cost with where its numbers came from, shown on hover or keyboard focus so the
// row itself stays short. The note is drawn in a fixed layer, so scrolling panels and tables
// don't clip it, and it stays open while the pointer moves onto it (for a source link).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Place = {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  maxWidth: number;
};

export function CostWhy({
  children,
  why,
}: {
  children: ReactNode;
  why: ReactNode;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const closing = useRef<number | undefined>(undefined);
  const [place, setPlace] = useState<Place | null>(null);
  const show = () => {
    window.clearTimeout(closing.current);
    const box = anchor.current?.getBoundingClientRect();
    if (!box) return;
    // Line the note up with the amount's right edge, or its left edge when that leaves too
    // little room (an amount near the left of a phone screen).
    const width = Math.min(320, window.innerWidth - 16);
    const left = Math.max(8, box.left);
    const side =
      box.right - width >= 8
        ? { right: window.innerWidth - box.right, maxWidth: width }
        : { left, maxWidth: Math.min(width, window.innerWidth - left - 8) };
    setPlace(
      window.innerHeight - box.bottom < 180
        ? { ...side, bottom: window.innerHeight - box.top + 6 }
        : { ...side, top: box.bottom + 6 },
    );
  };
  const hide = () => {
    window.clearTimeout(closing.current);
    closing.current = window.setTimeout(() => setPlace(null), 150);
  };
  useEffect(() => {
    if (!place) return;
    const close = () => setPlace(null);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [place]);
  useEffect(() => () => window.clearTimeout(closing.current), []);
  return (
    <span
      ref={anchor}
      className="cost-why"
      tabIndex={0}
      aria-describedby={id}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {place &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            className="cost-why-note"
            style={place}
            onMouseEnter={show}
            onMouseLeave={hide}
          >
            {why}
          </span>,
          document.body,
        )}
    </span>
  );
}
