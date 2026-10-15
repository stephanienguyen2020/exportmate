import { useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Download,
  FileText,
  Plus,
  Upload,
} from "lucide-react";
import { initialOrders, money, sampleObligation } from "../data";
import { errorMessage } from "../auth";
import { DEFAULT_CURRENCY, MAX_UPLOAD_MB, REQUIRED_COLUMNS } from "../order-csv";
import type { CheckedImport, Workspace } from "./store";
import { Button, PageHeading, download, go, plural, type Notify } from "./ui";

// The CSV template: the columns, with the demo's first sample order as the example row.
function templateCsv() {
  const columns = [...REQUIRED_COLUMNS, "currency"];
  const example: Record<string, unknown> = { currency: DEFAULT_CURRENCY, ...initialOrders[0] };
  const cell = (v: unknown) => {
    const text = String(v ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${columns.join(",")}\n${columns.map((c) => cell(example[c])).join(",")}\n`;
}

export default function DataRoom({
  ws,
  notify,
}: {
  ws: Workspace;
  notify: Notify;
}) {
  const { live, editable, orders } = ws;
  const [fileName, setFileName] = useState("");
  const [checked, setChecked] = useState<CheckedImport | null>(null);
  const [checking, setChecking] = useState(false);
  // A newer file replaces the result of one still being checked.
  const uploadVersion = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = ws.busy || checking;
  const errors = checked?.errors ?? [];
  const preview = checked?.preview ?? [];
  const rowCount = checked?.rowCount ?? 0;
  async function checkFile(file?: File) {
    if (!editable) {
      notify("Only company owners and editors can import orders.", true);
      return;
    }
    if (busy) return;
    const version = ++uploadVersion.current;
    setChecked(null);
    if (!file) return;
    setFileName(file.name);
    setChecking(true);
    try {
      const result = await ws.checkImport(file);
      if (version === uploadVersion.current) setChecked(result);
    } catch (error) {
      if (version === uploadVersion.current)
        setChecked({
          id: null,
          status: "invalid",
          rowCount: 0,
          duplicateOfImportId: null,
          preview: [],
          errors: [errorMessage(error)],
        });
    } finally {
      setChecking(false);
    }
  }
  const commit = () =>
    ws.mutate(async () => {
      if (!checked || checked.status !== "validated") return;
      const { created, added, run } = await ws.commitImport(checked);
      setChecked(null);
      setFileName("");
      if (added) {
        const flagged = added.filter((o) => o.risk).length;
        notify(
          `${plural(added.length, "order")} imported. ${flagged ? `${plural(flagged, "order")} need${flagged === 1 ? "s" : ""} action under the sample rule change.` : "None is affected by the sample rule change."}`,
        );
      } else if (run) {
        const counts = new Map<string, number>();
        for (const r of run.reports)
          counts.set(r.orderStatus, (counts.get(r.orderStatus) || 0) + 1);
        const summary = [...counts]
          .map(([code, n]) => `${ws.statusOption(code)?.label || code}: ${n}`)
          .join(" · ");
        notify(`${plural(created, "order")} imported and analysed. ${summary}.`);
      } else
        notify(
          `${plural(created, "order")} imported, but the analysis didn't finish. Run it from the Orders page.`,
          true,
        );
      go("orders");
    });
  return (
    <>
      <PageHeading
        label="YOUR DATA. THE START OF SOMETHING CLEARER."
        title="Import your data."
        description="Start with an orders CSV."
        action={
          <a className="btn secondary" href="#/workspace/regulations">
            Regulation documents <FileText size={16} />
          </a>
        }
      />
      <div className="data-grid">
        <section
          className="upload-zone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void checkFile(e.dataTransfer.files[0]);
          }}
        >
          <div className="upload-icon">
            <Upload size={30} />
          </div>
          <h2>A spreadsheet is a great start.</h2>
          <p>
            Drop your orders CSV here, or choose a file.
            <br />
            {live
              ? `Up to ${MAX_UPLOAD_MB} MB. Files are saved to your company workspace.`
              : `Up to ${MAX_UPLOAD_MB} MB. Your file stays in this browser.`}
          </p>
          {!editable && (
            <p className="notice" role="note">
              Only company owners and editors can import orders. Ask your
              company owner for editor access.
            </p>
          )}
          <Button
            disabled={busy || !editable}
            onClick={() => fileRef.current?.click()}
          >
            <Plus size={17} />
            Choose a CSV file
          </Button>
          <input
            ref={fileRef}
            disabled={busy || !editable}
            type="file"
            accept=".csv,text/csv"
            aria-label="Upload orders CSV"
            hidden
            onChange={(e) => {
              void checkFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            className="text-link template"
            onClick={() =>
              download("exportmate-orders-template.csv", templateCsv())
            }
          >
            <Download size={15} />
            Download the template
          </button>
          <a
            className="text-link template"
            href="/samples/exportmate-sample-orders.csv"
            download
          >
            <Download size={15} />
            Download sample orders (24 rows)
          </a>
        </section>
        <section className="data-help">
          <span className="eyebrow">A GOOD FIRST STEP</span>
          <h3>
            Less setup. <br />
            More clarity.
          </h3>
          <p>For each order, include:</p>
          <ul>
            <li>Order ID and product</li>
            <li>Supplier and destination</li>
            <li>
              Order value (optional currency column, e.g. USD; otherwise{" "}
              {live
                ? `your company currency, ${ws.account?.company?.currency || "USD"}`
                : "USD"}
              )
            </li>
            <li>Ship date and HS code</li>
          </ul>
          <p className="fine-print">
            Not supported yet: Excel files (save them as CSV), photos of stock
            slips, bill-of-materials matching and reading documents.
          </p>
        </section>
      </div>
      {fileName && (
        <section className="panel import-preview">
          <div className="section-heading">
            <h3>{fileName}</h3>
            <span className={"status " + (errors.length ? "red" : "green")}>
              {errors.length
                ? "Needs a correction"
                : busy
                  ? "Validating…"
                  : checked?.status === "committed"
                    ? "Already imported"
                    : `${rowCount} valid rows`}
            </span>
          </div>
          {checked?.duplicateOfImportId && (
            <p className="notice" role="note">
              This file matches an import you already committed. Its orders are
              already in your workspace.
            </p>
          )}
          {errors.length ? (
            <ul className="error-list" role="alert">
              {errors.slice(0, 10).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {errors.length > 10 && (
                <li>
                  …and {errors.length - 10} more. Fix these first, then upload
                  the file again.
                </li>
              )}
            </ul>
          ) : (
            <>
              <p>
                {live
                  ? "Checked and ready. Imported orders wait for analysis: start it from the Orders page. Their market checklists are on the trade map."
                  : `Checked in your browser. On import, each order is checked against the sample rule change (${sampleObligation.title.toLowerCase()}).`}
              </p>
              {preview.some((o) => !o.hsCode) && (
                <p className="notice" role="note">
                  {plural(preview.filter((o) => !o.hsCode).length, "row")}{" "}
                  without an HS code.{" "}
                  {live
                    ? "They import as needing data; on each order's page you can ask for a code suggestion."
                    : "Their market checks need one."}
                </p>
              )}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Product</th>
                      <th>Destination</th>
                      <th>Value</th>
                      <th>HS code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.slice(0, 10).map((o) => (
                      <tr key={o.id}>
                        <td>{o.id}</td>
                        <td>{o.product}</td>
                        <td>{o.destination}</td>
                        <td>{money(o.value, o.currency)}</td>
                        <td>
                          {o.hsCode || (
                            <small className="muted">
                              {live
                                ? "No HS code: you can ask for a suggestion after import"
                                : "No HS code: the order will need one"}
                            </small>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rowCount > 10 && (
                <p className="fine-print">
                  Showing the first 10 of {rowCount} rows.
                </p>
              )}
              <Button
                disabled={
                  busy ||
                  !editable ||
                  !preview.length ||
                  checked?.status !== "validated"
                }
                onClick={() => void commit()}
              >
                {busy
                  ? "Processing…"
                  : checked?.status === "committed"
                    ? "Already imported"
                    : `Import ${rowCount} orders`}
                <ArrowRight size={17} />
              </Button>
            </>
          )}
        </section>
      )}
      <div className="section-heading">
        <h2>Already in your workspace.</h2>
        <span className="eyebrow">
          {live ? "SERVER DATA" : "BROWSER-LOCAL DATA"}
        </span>
      </div>
      <section className="connected-file">
        <FileText size={25} />
        <div>
          <b>Open orders</b>
          <p>
            {orders.length} rows ·{" "}
            {!live && orders.length - initialOrders.length > 0
              ? `${orders.length - initialOrders.length} imported + `
              : ""}
            {live
              ? "saved in your company workspace"
              : `${initialOrders.length} sample records`}
          </p>
        </div>
        <span className="status green">
          <Check size={13} />
          Available
        </span>
        <button className="text-link" onClick={() => go("orders")}>
          View data
          <ArrowUpRight size={16} />
        </button>
      </section>
    </>
  );
}
