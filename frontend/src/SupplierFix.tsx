// The trade map's supplier form on an order's page: add the order's supplier, or record the
// documents it has given you, without leaving the order. The documents the order's checklist
// still asks for come first. Saving analyses every order that names the supplier again
// (backend), so the order's report moves on to the next step. Lazy-loaded: it brings the
// trade map's form, model and styles.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, type CheckStatus, type TradeMap } from "./api";
import { errorMessage } from "./auth";
import { SupplierForm } from "./trade-map/forms";
import {
  type Pin,
  type SupplierGroup,
  rowOf,
  supplierGroupOf,
  supplierKey,
} from "./trade-map/model";
import "./trade-map.css";

export type SupplierSaved = {
  name: string;
  analysedOrderIds: string[];
  // false: the saved name doesn't match the order's supplier, so the order isn't checked
  // against this record.
  matchesOrder: boolean;
};

// Checks a supplier record still has to answer.
const STILL_ASKED = new Set<CheckStatus>(["unknown", "missing", "mismatch"]);

export default function SupplierFix(props: {
  orderId: string;
  supplier: string;
  onSaved: (saved: SupplierSaved) => Promise<void>;
  onDeleted: (analysedOrderIds: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [data, setData] = useState<TradeMap | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api
      .tradeMap(controller.signal)
      .then((value) => !controller.signal.aborted && setData(value))
      .catch((e) => !controller.signal.aborted && setError(errorMessage(e)));
    return () => controller.abort();
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!data)
    return (
      <p role="status">
        <Loader2 size={15} className="spin" /> Loading your suppliers…
      </p>
    );
  const key = supplierKey(props.supplier);
  const listed = data.suppliers.find(
    (s) => s.id && supplierKey(s.name) === key,
  );
  const rowsById = new Map(data.orders.map((o) => [o.order.id, rowOf(o)]));
  return (
    <FixForm
      {...props}
      data={data}
      group={listed ? supplierGroupOf(listed, rowsById) : null}
      supplierKey={key}
    />
  );
}

function FixForm({
  orderId,
  supplier,
  data,
  group,
  supplierKey: key,
  onSaved,
  onDeleted,
  onCancel,
}: {
  orderId: string;
  supplier: string;
  data: TradeMap;
  group: SupplierGroup | null;
  supplierKey: string;
  onSaved: (saved: SupplierSaved) => Promise<void>;
  onDeleted: (analysedOrderIds: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  // Editing keeps the location on file: the form sends what the field holds.
  const [pin, setPin] = useState<Pin | null>(() =>
    group?.at ? { at: group.at, country: null, picked: 0 } : null,
  );
  const checks = data.orders.find((o) => o.order.id === orderId)?.checks ?? [];
  return (
    <SupplierForm
      group={group}
      name={supplier}
      documentKinds={data.documentKinds}
      countries={data.countries}
      pin={pin}
      onPin={setPin}
      mapless
      needed={{
        orderId,
        checks: checks.filter(
          (c) => c.level === "supplier" && STILL_ASKED.has(c.status),
        ),
      }}
      onSaved={(name, saved) =>
        onSaved({
          name,
          analysedOrderIds: saved.analysedOrderIds,
          matchesOrder: supplierKey(name) === key,
        })
      }
      onDeleted={onDeleted}
      onCancel={onCancel}
    />
  );
}
