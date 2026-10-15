import React, { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Download, Loader2, Send, X } from "lucide-react";
import {
  date,
  makerCost,
  money,
  sampleCosts,
  sampleGap,
  sampleObligation,
  type Order,
} from "../data";
import { valueAtRisk, type Workspace } from "./store";
import {
  Button,
  download,
  go,
  listNames,
  orderPath,
  plural,
  type Notify,
} from "./ui";

// The browser demo's dialogs: the simulated rule-change walkthrough, a
// supplier message to confirm, and the evidence behind a sample finding.
export type DemoDialog =
  | { kind: "demo" }
  | { kind: "message"; order: Order }
  | { kind: "evidence"; order: Order };

const costMoney = (n: number) => money(n, sampleCosts.maker.currency);

// A modal that keeps focus inside it and, unless told not to, closes on
// Escape or a click on the backdrop.
function Dialog({
  dismissable = true,
  onClose,
  children,
}: {
  dismissable?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // A ref so focus handling doesn't re-run while the walkthrough plays.
  const canDismiss = useRef(dismissable);
  canDismiss.current = dismissable;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape" && canDismiss.current) onClose();
      if (e.key === "Tab") {
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not(:disabled),textarea,input,select,[tabindex="0"]',
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialogRef.current)
        ) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === dialogRef.current)
        ) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", fn);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", fn);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && dismissable) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <button
          className="modal-close icon-btn"
          aria-label="Close dialog"
          disabled={!dismissable}
          onClick={onClose}
        >
          <X size={20} />
        </button>
        {children}
      </div>
    </div>
  );
}

export default function DemoDialogs({
  dialog,
  ws,
  buyer,
  notify,
  onClose,
}: {
  dialog: DemoDialog;
  ws: Workspace;
  buyer: boolean;
  notify: Notify;
  onClose: () => void;
}) {
  if (dialog.kind === "demo")
    return <RuleChangeRun ws={ws} buyer={buyer} onClose={onClose} />;
  if (dialog.kind === "message")
    return (
      <SupplierMessage
        order={dialog.order}
        ws={ws}
        notify={notify}
        onClose={onClose}
      />
    );
  return <Evidence order={dialog.order} onClose={onClose} />;
}

const LAST_STEP = 6;

// Steps play one a second; the sample change lands on the sixth.
function RuleChangeRun({
  ws,
  buyer,
  onClose,
}: {
  ws: Workspace;
  buyer: boolean;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const { orders, exposed } = ws;
  useEffect(() => {
    if (step >= LAST_STEP) return;
    const t = setTimeout(() => {
      if (step === LAST_STEP - 1) ws.applySampleChange();
      setStep((x) => x + 1);
    }, 1000);
    return () => clearTimeout(t);
  }, [step]);
  // What the walkthrough finds, worked out while its steps play.
  const matches = orders.filter((o) => sampleGap(o));
  const steps = [
    [
      "Relevance",
      `Covers HS ${sampleObligation.hsPrefixes.join(", ")} or ${sampleObligation.materials.join(", ")} products bound for the ${sampleObligation.market}.`,
    ],
    [
      "Order exposure",
      matches.length
        ? `${listNames(matches.slice(0, 4).map((o) => o.id))}${matches.length > 4 ? ` and ${matches.length - 4} more` : ""} ${matches.length === 1 ? "lacks" : "lack"} supplier ${sampleObligation.records}.`
        : "No open order is covered and missing records.",
    ],
    [
      "Cost impact",
      buyer
        ? `${money(sampleCosts.buyer.margin, sampleCosts.buyer.currency)} buyer margin exposure per order.`
        : `${costMoney(sampleCosts.maker.documentation)} documentation + ${costMoney(sampleCosts.maker.delayDays * sampleCosts.maker.delayPerDay)} potential delay per order.`,
    ],
    [
      "Action planner",
      matches.length
        ? `Draft a request to ${listNames([...new Set(matches.map((o) => o.supplier))])} for ${sampleObligation.records}.`
        : "No supplier request needed.",
    ],
    ["Auditor", "Rejected: alternate supplier claim has no evidence."],
    [
      "Corrected & verified",
      "Unsupported claim removed. Clause and order rows linked.",
    ],
  ];
  return (
    <Dialog dismissable={step >= LAST_STEP} onClose={onClose}>
      <span className="eyebrow">A RULE CHANGES. THE DOTS CONNECT.</span>
      <h2 id="modal-title">
        {step < LAST_STEP
          ? "From change to clarity."
          : "Now you know your next move."}
      </h2>
      <p>
        A simulated {sampleObligation.market} {sampleObligation.material}-documentation
        change, matched against your{" "}
        {plural(orders.length, "open order")}. This resets the sample orders
        and demo confirmations. Imported orders are kept and checked too.
      </p>
      <div className="demo-trace">
        {steps.map(([title, text], i) => (
          <div key={title} className={step >= i ? "complete" : "pending"}>
            <span className={"step-marker " + (i === 4 ? "audit" : "")}>
              {step > i ? (
                <Check size={16} />
              ) : step === i ? (
                <Loader2 size={16} className="spin" />
              ) : (
                i + 1
              )}
            </span>
            <div>
              <b>{title}</b>
              <p>{step >= i ? text : "Waiting for previous step"}</p>
            </div>
          </div>
        ))}
      </div>
      {step === LAST_STEP && (
        <>
          <div className="demo-result">
            <b>{plural(exposed.length, "order")} affected.</b>
            <span>
              {valueAtRisk(ws, buyer).display} estimated{" "}
              {buyer ? "buyer" : "maker"} exposure.
            </span>
          </div>
          <Button
            onClick={() => {
              onClose();
              go(exposed[0] ? orderPath(exposed[0].id) : "orders");
            }}
          >
            Review your next move
            <ArrowRight size={17} />
          </Button>
        </>
      )}
    </Dialog>
  );
}

function SupplierMessage({
  order,
  ws,
  notify,
  onClose,
}: {
  order: Order;
  ws: Workspace;
  notify: Notify;
  onClose: () => void;
}) {
  const { profile } = ws;
  const [message, setMessage] = useState(
    () =>
      `Hello ${order.supplier},\n\nWe’re preparing ${order.id} (${order.product}) for shipment on ${date(order.shipDate)} to ${order.destination}.\n\nPlease share the ${sampleObligation.requirement} data and supporting origin records for the ${sampleObligation.material} used in this order. We need these to review the documentation for our ${sampleObligation.market}-bound shipment.\n\nCould you confirm availability and an expected delivery date?\n\nThank you,\n${profile.name} · ${profile.company || "Your company"}`,
  );
  return (
    <Dialog onClose={onClose}>
      <span className="eyebrow">YOUR ACTION. YOUR APPROVAL.</span>
      <h2 id="modal-title">
        A conversation that
        <br />
        keeps things moving.
      </h2>
      <div className="message-to">
        <b>To: {order.supplier}</b>
        <span>Zalo · {order.id}</span>
      </div>
      <label htmlFor="supplier-message" className="sr-only">
        Supplier message draft
      </label>
      <textarea
        id="supplier-message"
        className="message-editor"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="notice">
        Demo only. Confirming records this action locally; no message is sent.
      </div>
      <Button
        disabled={!message.trim()}
        onClick={() => {
          ws.markSent(order.id);
          onClose();
          notify("Demo message confirmed. No external message was sent.");
        }}
      >
        Confirm demo message
        <Send size={16} />
      </Button>
    </Dialog>
  );
}

function Evidence({ order, onClose }: { order: Order; onClose: () => void }) {
  const { maker } = sampleCosts;
  return (
    <Dialog onClose={onClose}>
      <span className="eyebrow">EVERY CLAIM SHOULD HAVE A HOME.</span>
      <h2 id="modal-title">Follow the evidence.</h2>
      <div className="notice">
        These are illustrative fixtures. They are not verified legal text or
        current compliance guidance.
      </div>
      <h3>01 / Sample source clause</h3>
      <blockquote>
        “{sampleObligation.quote}”
      </blockquote>
      <p className="fine-print">
        Demo obligation {sampleObligation.id} · illustrative §9. Production must link a
        versioned official document and exact clause.
      </p>
      <h3>02 / Your order row</h3>
      <div className="evidence-data">
        <span>orders.csv</span>
        <b>{order.id}</b>
        <span>Product</span>
        <b>
          {order.product} · HS {order.hsCode}
        </b>
        <span>Supplier</span>
        <b>{order.supplier}</b>
        <span>Destination</span>
        <b>{order.destination}</b>
        <span>{sampleObligation.evidence}</span>
        <b className="danger">
          {sampleGap(order) || "On file in the supplier record"}
        </b>
      </div>
      <h3>03 / Cost assumptions</h3>
      <p>
        {costMoney(maker.documentation)} documentation preparation +{" "}
        {maker.delayDays} possible delay days × {costMoney(maker.delayPerDay)}
        /day = <b>{costMoney(makerCost)} estimated exposure</b>. Demo planning
        assumptions, not figures set by the sample clause.
      </p>
      <Button
        onClick={() =>
          download(
            "exportmate-" + order.id + "-evidence.txt",
            `FICTIONAL DEMO EVIDENCE\nOrder: ${order.id}\nProduct: ${order.product}\nSupplier: ${order.supplier}\nHS code: ${order.hsCode}\nDestination: ${order.destination}\nSample obligation: ${sampleObligation.id} (${sampleObligation.title})\nFinding: ${sampleGap(order) || `${sampleObligation.records} on file`}\nAssumptions: ${maker.currency} ${maker.documentation} documentation + ${maker.delayDays} days x ${maker.currency} ${maker.delayPerDay}/day = ${maker.currency} ${makerCost}.\nNot verified legal text or advice.\n`,
            "text/plain",
          )
        }
      >
        <Download size={16} />
        Download evidence summary
      </Button>
    </Dialog>
  );
}
