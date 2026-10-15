// First-visit walkthrough of the workspace: a spotlight on each part of the
// sidebar with a short note, skippable at any step. Shown once per browser
// (`em-tour-done` in localStorage); the "?" in the top bar replays it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import "./tour.css";

type TourStep = {
  // A `data-tour` value; without one (or when it's hidden, as the sidebar is
  // on phones) the step is a card in the middle of the screen.
  target?: string;
  title: string;
  body: string;
};

const DONE_KEY = "em-tour-done";

export function tourDone() {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
}

function markTourDone() {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    // Private windows can refuse storage; the tour then shows again next visit.
  }
}

function tourSteps(live: boolean): TourStep[] {
  return [
    {
      title: "Welcome to ExportMate.",
      body: live
        ? "A one-minute look at where things are in your workspace. Skip it whenever you like; the ? button at the top brings it back."
        : "This is a sample workspace for a Vietnamese furniture maker, so nothing you do here touches real data. A one-minute look at where things are; skip it whenever you like.",
    },
    {
      target: "nav-",
      title: "Overview",
      body: "Start here each day: which orders need action, the value at risk and what changed since you last looked.",
    },
    {
      target: "nav-orders",
      title: "Orders",
      body: "Every shipment with its status. Open one to see what its destination market asks for and what's still missing.",
    },
    {
      target: "nav-map",
      title: "Trade map",
      body: "Your suppliers, sites and routes on a globe, with the documents each market wants and which ones you have on file.",
    },
    {
      target: "nav-news",
      title: "News watch",
      body: "Trade news read every day and matched to the products you sell, so you only see articles that affect you.",
    },
    {
      target: "nav-rules",
      title: "Rule watch",
      body: live
        ? "The requirements behind your orders' market checklists, and which orders each one touches."
        : "A rule change and the orders it affects. Try “Run rule-change demo” there to see one play out.",
    },
    {
      target: "nav-regulations",
      title: "Regulations",
      body: "The official texts behind every check, with their version history, so each requirement can be traced to its source.",
    },
    {
      target: "nav-reports",
      title: "Reports",
      body: "Build an order or company report, edit it, then download a PDF or email it to your team or buyer.",
    },
    {
      target: "nav-data",
      title: "Data room",
      body: "Bring your orders in from a spreadsheet: upload a CSV, review the rows, then import them.",
    },
    {
      target: "nav-playbook",
      title: "Playbook",
      body: "Your company's own rules, such as who must review what. Switched-on rules are applied when orders are checked.",
    },
    ...(live
      ? []
      : [
          {
            target: "perspective",
            title: "Maker or buyer",
            body: "See the same orders as the maker in Vietnam or as a buyer in Singapore.",
          },
        ]),
    {
      target: "chat",
      title: "Ask the assistant",
      body: "Ask about your orders, stock or the news in plain words. Every answer cites where its facts came from.",
    },
    {
      target: "help",
      title: "That's it.",
      body: "Open this tour again any time from here.",
    },
  ];
}

function visibleTarget(name: string | undefined) {
  if (!name) return null;
  const element = document.querySelector<HTMLElement>(
    `[data-tour="${name}"]`,
  );
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return rect.width && rect.height ? element : null;
}

const GAP = 14;
const MARGIN = 16;

// Beside the target if there's room (right, left, below, above), kept on screen.
function placeCard(target: DOMRect, width: number, height: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const midY = target.top + target.height / 2 - height / 2;
  const midX = target.left + target.width / 2 - width / 2;
  const right = target.right + GAP;
  const left = target.left - GAP - width;
  const below = target.bottom + GAP;
  const above = target.top - GAP - height;
  const options = [
    { left: right, top: midY, fits: right + width <= vw - MARGIN },
    { left: left, top: midY, fits: left >= MARGIN },
    { left: midX, top: below, fits: below + height <= vh - MARGIN },
    { left: midX, top: above, fits: above >= MARGIN },
  ];
  const chosen = options.find((o) => o.fits) || options[2];
  const clamp = (value: number, max: number) =>
    Math.max(MARGIN, Math.min(value, max - MARGIN));
  return {
    left: clamp(chosen.left, vw - width),
    top: clamp(chosen.top, vh - height),
  };
}

export default function Tour({
  live,
  onClose,
}: {
  live: boolean;
  onClose: () => void;
}) {
  const steps = tourSteps(live);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [round, setRound] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const step = steps[index];
  const last = index === steps.length - 1;

  function close() {
    markTourDone();
    onClose();
  }

  // Focus goes back to wherever it was when the tour ends.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus?.();
  }, []);

  useLayoutEffect(() => {
    const element = visibleTarget(step.target);
    element?.scrollIntoView({ block: "nearest" });
    // The round chat button gets a round spotlight.
    setRound(!!element && getComputedStyle(element).borderRadius === "50%");
    function measure() {
      const targetRect = visibleTarget(step.target)?.getBoundingClientRect();
      setRect(targetRect || null);
      const box = card.current;
      setPosition(
        targetRect && box
          ? placeCard(targetRect, box.offsetWidth, box.offsetHeight)
          : null,
      );
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [index, step.target]);

  useEffect(() => {
    next.current?.focus();
  }, [index]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
      else if (event.key === "ArrowRight" && !last) setIndex((i) => i + 1);
      else if (event.key === "ArrowLeft" && index > 0) setIndex((i) => i - 1);
      else if (event.key === "Tab") {
        // Keep focus inside the card while the rest of the page is covered.
        const buttons = card.current?.querySelectorAll<HTMLElement>("button");
        if (!buttons?.length) return;
        const first = buttons[0];
        const end = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          end.focus();
        } else if (!event.shiftKey && document.activeElement === end) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <div className="tour">
      <div className={"tour-shade" + (rect ? "" : " full")} />
      {rect && (
        <div
          className={"tour-spotlight" + (round ? " round" : "")}
          style={{
            left: rect.left - 6,
            top: rect.top - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      )}
      <div
        ref={card}
        className={"tour-card" + (position ? "" : " centered")}
        style={position || undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
      >
        <div className="tour-head">
          <span className="eyebrow">
            {index === 0
              ? "WORKSPACE TOUR"
              : `STEP ${index} OF ${steps.length - 1}`}
          </span>
          <button
            className="icon-btn"
            aria-label="Skip the tour"
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-body">{step.body}</p>
        <div className="tour-dots" aria-hidden="true">
          {steps.map((_, i) => (
            <i key={i} className={i === index ? "on" : ""} />
          ))}
        </div>
        <div className="tour-actions">
          {index === 0 ? (
            <button className="tour-skip" onClick={close}>
              Skip tour
            </button>
          ) : (
            <button className="tour-skip" onClick={() => setIndex(index - 1)}>
              <ArrowLeft size={14} />
              Back
            </button>
          )}
          <button
            ref={next}
            className="btn"
            onClick={() => (last ? close() : setIndex(index + 1))}
          >
            {last ? "Done" : index === 0 ? "Show me around" : "Next"}
            {!last && <ArrowRight size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}
