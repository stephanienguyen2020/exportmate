// An analysis report's next moves as buttons, for owners and editors. Each opens the form that
// makes the change on the order's page: the order's own facts (its HS code, destination, ship
// date or supplier name, via `onEditOrder`), or its supplier record and documents
// (SupplierFix, the trade map's supplier form). Saving either analyses the order again, so the
// report then shows the move after it. Which moves apply comes from the report's own fields
// (the order, its market, the checks and the suggested action), so earlier reports get them too.
import { lazy, Suspense, useState } from "react";
import {
  Building2,
  FileCheck2,
  Loader2,
  PenLine,
  Send,
  type LucideIcon,
} from "lucide-react";
import type { AnalysisReport } from "./api";
import type { SupplierSaved } from "./SupplierFix";
import { analysedAgain } from "./workspace/ui";

const SupplierFix = lazy(() => import("./SupplierFix"));

// The order fields a next move can open for editing.
export type OrderField = "supplier" | "destination" | "shipDate" | "hsCode";

type Move = {
  key: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
};

export default function NextMoves({
  report,
  notify,
  onEditOrder,
  onAskSupplier,
  onChanged,
}: {
  report: AnalysisReport;
  notify: (text: string, error?: boolean) => void;
  onEditOrder: (field: OrderField) => void;
  onAskSupplier: () => void;
  // A supplier change analysed orders again: reload the order and the lists.
  onChanged: () => Promise<void>;
}) {
  const [fixing, setFixing] = useState(false);
  const { order, findings } = report;
  const noRecord = findings.some((f) => f.status === "unknown");
  const documentGaps = findings.some(
    (f) =>
      f.level === "supplier" &&
      (f.status === "missing" || f.status === "mismatch"),
  );
  // In the order the report lists what's missing, so the first matches its headline.
  const moves: Move[] = [];
  const editOrder = (key: OrderField, label: string) =>
    moves.push({ key, label, icon: PenLine, run: () => onEditOrder(key) });
  if (!order.hsCode) editOrder("hsCode", "Add the HS code");
  if (!report.market) editOrder("destination", "Correct the destination");
  if (noRecord)
    moves.push({
      key: "supplier-record",
      label: `Add ${order.supplier} with its documents`,
      icon: Building2,
      run: () => setFixing(true),
    });
  else if (documentGaps) {
    // Asking comes first: it's the report's suggested action. Recording is for documents
    // already in hand.
    if (!report.messageBlockedReason)
      moves.push({
        key: "ask",
        label: `Ask ${order.supplier} for them`,
        icon: Send,
        run: onAskSupplier,
      });
    moves.push({
      key: "supplier-documents",
      label: `Record documents from ${order.supplier}`,
      icon: FileCheck2,
      run: () => setFixing(true),
    });
  }
  if (report.suggestedAction.kind === "move_ship_date")
    editOrder("shipDate", "Change the ship date");
  if (!moves.length) return null;

  const saved = async ({
    name,
    analysedOrderIds,
    matchesOrder,
  }: SupplierSaved) => {
    setFixing(false);
    await onChanged();
    if (!matchesOrder)
      notify(
        `${name} saved, but ${order.id} names “${order.supplier}”, so it isn't checked against it. Correct the supplier on the order.`,
        true,
      );
    else if (!analysedOrderIds.includes(order.id))
      notify(
        `${name} saved. ${order.id} wasn't analysed again: use “Analyse again”.`,
        true,
      );
    else notify(`${name} saved.${analysedAgain(analysedOrderIds)}`);
  };
  const deleted = async (analysedOrderIds: string[]) => {
    setFixing(false);
    await onChanged();
    notify(`${order.supplier} deleted.${analysedAgain(analysedOrderIds)}`);
  };

  if (fixing)
    return (
      <div className="an-fix">
        <Suspense
          fallback={
            <p role="status">
              <Loader2 size={15} className="spin" /> Loading your suppliers…
            </p>
          }
        >
          <SupplierFix
            orderId={order.id}
            supplier={order.supplier}
            onSaved={saved}
            onDeleted={deleted}
            onCancel={() => setFixing(false)}
          />
        </Suspense>
      </div>
    );
  return (
    <div className="an-moves" role="group" aria-label="Next moves">
      {moves.map(({ key, label, icon: Icon, run }, i) => (
        <button
          key={key}
          type="button"
          className={"btn" + (i ? " secondary" : "")}
          onClick={run}
        >
          <Icon size={15} />
          {label}
        </button>
      ))}
      {noRecord && (
        <button
          type="button"
          className="text-link"
          onClick={() => onEditOrder("supplier")}
        >
          <PenLine size={14} />
          Or correct the supplier's name on the order
        </button>
      )}
    </div>
  );
}
