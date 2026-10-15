import React, { useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Loader2,
  Pencil,
  Plus,
  Upload,
  X,
} from "lucide-react";
import { type Order } from "../data";
import {
  api,
  type MapMarket,
  type MapSite,
  type SatelliteObservation,
  type SupplierDocumentUpload,
  type TradeMap,
} from "../api";
import { errorMessage } from "../auth";
import { FormActions } from "./forms";
import {
  type FloodEntry,
  type SupplierGroup,
  byShipDate,
  plural,
} from "./model";
import { FloodCallout, OrderLine, PanelHead } from "./panels";

export function SupplierPanel({
  group,
  documentKinds,
  floods,
  marketByCode,
  renderStatus,
  onBack,
  onOpenOrder,
  onCompare,
  onMarket,
  onFlood,
  onEdit,
  onCertificate,
}: {
  group: SupplierGroup;
  documentKinds: TradeMap["documentKinds"];
  floods: FloodEntry[];
  marketByCode: Map<string, MapMarket>;
  renderStatus: (order: Order) => React.ReactNode;
  onBack: () => void;
  onOpenOrder: (id: string) => void;
  onCompare: (id: string) => void;
  onMarket: (code: string) => void;
  onFlood: (flood: SatelliteObservation) => void;
  onEdit?: (group: SupplierGroup) => void;
  // Editors: after a certificate is confirmed, reload the map on this supplier.
  onCertificate?: (name: string) => Promise<void>;
}) {
  const near = floods.flatMap((f) =>
    f.suppliers
      .filter((s) => s.group.key === group.key)
      .map((s) => ({ flood: f.flood, km: s.km })),
  );
  const served = [
    ...new Set(group.rows.map((r) => r.placement.market).filter(Boolean)),
  ] as string[];
  return (
    <>
      <PanelHead
        eyebrow={`SUPPLIER · ${group.place?.toUpperCase() ?? "LOCATION NOT ON FILE"}`}
        title={group.name + "."}
        sub={group.supplies}
        onBack={onBack}
      />
      {onEdit && (
        <button className="text-link tm-edit" onClick={() => onEdit(group)}>
          {group.id ? <Pencil size={13} /> : <Plus size={13} />}
          {group.id ? "Edit supplier" : "Add a supplier record"}
        </button>
      )}
      {near.map(({ flood, km }) => (
        <FloodCallout
          key={flood.id}
          flood={flood}
          detail={`${km === 0 ? "inside the observed extent" : `${km} km from the observed edge`}. Worth a check-in; impact unconfirmed.`}
          onOpen={() => onFlood(flood)}
        />
      ))}
      <section className="tm-section">
        <h3>Open orders</h3>
        {group.rows.length ? (
          <ul className="tm-orders">
            {[...group.rows].sort(byShipDate).map((row) => (
              <OrderLine
                key={row.order.id}
                row={row}
                renderStatus={renderStatus}
                onOpen={onOpenOrder}
                onCompare={onCompare}
                show="destination"
              />
            ))}
          </ul>
        ) : (
          <p className="tm-muted">No open orders with this supplier.</p>
        )}
        {served.length > 0 && (
          <div className="tm-chips" aria-label="Markets served">
            {served.map((code) => (
              <button key={code} onClick={() => onMarket(code)}>
                {marketByCode.get(code)?.name ?? code}
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="tm-section">
        <h3>Documents on file</h3>
        {!group.documents ? (
          <p className="tm-muted">
            No supplier record yet, so there are no documents to show
            {onEdit ? ". Add one to record what this supplier has on file." : "."}
          </p>
        ) : (
          <ul className="tm-docs">
            {documentKinds.map(({ kind, label }) => {
              const doc = group.documents!.find((d) => d.kind === kind);
              return (
                <li key={kind} className={doc ? "on" : "off"}>
                  {doc ? <Check size={14} /> : <X size={14} />}
                  <span>
                    <b>{label}</b>
                    <small>
                      {doc
                        ? [
                            doc.detail,
                            doc.standards.join(", "),
                            doc.expiresOn && `expires ${doc.expiresOn}`,
                            doc.fromUpload && "from an uploaded certificate",
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : "Not on file"}
                    </small>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {onCertificate && group.id && (
          <CertificateUpload
            supplierId={group.id}
            supplierName={group.name}
            documentKinds={documentKinds}
            onConfirmed={() => onCertificate(group.name)}
          />
        )}
      </section>
    </>
  );
}

// Upload a certificate, check what AI read from it, confirm. Nothing counts in checks or
// analysis until a person confirms the fields.
function CertificateUpload({
  supplierId,
  supplierName,
  documentKinds,
  onConfirmed,
}: {
  supplierId: string;
  supplierName: string;
  documentKinds: TradeMap["documentKinds"];
  onConfirmed: () => Promise<void>;
}) {
  const [upload, setUpload] = useState<SupplierDocumentUpload | null>(null);
  const [fields, setFields] = useState({
    kind: "",
    detail: "",
    standards: "",
    number: "",
    issuer: "",
    expiresOn: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const pick = async (file?: File) => {
    if (!file) return;
    setError("");
    if (!/\.(pdf|png|jpe?g)$/i.test(file.name))
      return setError("Choose a PDF, PNG or JPEG file.");
    if (!file.size || file.size > 4 * 1024 * 1024)
      return setError("Choose a non-empty file up to 4 MB.");
    setBusy(true);
    try {
      const result = await api.uploadSupplierDocument(supplierId, file);
      const read = result.extracted;
      setUpload(result);
      setFields({
        kind: read.kind ?? "",
        detail: read.detail,
        standards: read.standards.join(", "),
        number: read.documentNumber ?? "",
        issuer: read.issuer ?? "",
        expiresOn: read.expiresOn ?? "",
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!upload) return;
    setBusy(true);
    setError("");
    try {
      await api.confirmSupplierDocument(upload.id, {
        kind: fields.kind,
        detail: fields.detail.trim(),
        standards: fields.standards
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        documentNumber: fields.number.trim() || null,
        issuer: fields.issuer.trim() || null,
        expiresOn: fields.expiresOn || null,
      });
      setUpload(null);
      await onConfirmed();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const set = (change: Partial<typeof fields>) =>
    setFields((all) => ({ ...all, ...change }));
  if (!upload)
    return (
      <div className="tm-upload">
        <button
          type="button"
          className="text-link"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}
          {busy ? "Reading the certificate…" : "Upload certificate"}
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          aria-label={`Upload a certificate for ${supplierName}`}
          accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <small>PDF, PNG or JPEG, up to 4 MB. AI reads it; you confirm.</small>
        {error && (
          <p className="tm-field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  const read = upload.extracted;
  return (
    <form className="tm-form tm-upload-form" onSubmit={confirm}>
      <h3>Check what AI read.</h3>
      <small>
        {upload.filename}. Nothing is checked against orders until you
        confirm. It replaces {supplierName}'s document of the same kind.
      </small>
      {read.notes && <p className="tm-muted">Hard to read: {read.notes}</p>}
      <label htmlFor="tm-cert-kind">Document</label>
      <select
        id="tm-cert-kind"
        required
        value={fields.kind}
        onChange={(e) => set({ kind: e.target.value })}
      >
        <option value="">Choose a kind</option>
        {documentKinds.map(({ kind, label }) => (
          <option key={kind} value={kind}>
            {label}
          </option>
        ))}
      </select>
      <label htmlFor="tm-cert-detail">What's on file</label>
      <input
        id="tm-cert-detail"
        required
        maxLength={1000}
        value={fields.detail}
        onChange={(e) => set({ detail: e.target.value })}
      />
      <label htmlFor="tm-cert-number">Document number (optional)</label>
      <input
        id="tm-cert-number"
        maxLength={100}
        value={fields.number}
        onChange={(e) => set({ number: e.target.value })}
      />
      <label htmlFor="tm-cert-issuer">Issued by (optional)</label>
      <input
        id="tm-cert-issuer"
        maxLength={200}
        value={fields.issuer}
        onChange={(e) => set({ issuer: e.target.value })}
      />
      {read.issuedOn && (
        <small>Issued on {read.issuedOn}, as read from the file.</small>
      )}
      <label htmlFor="tm-cert-expires">Expires on (optional)</label>
      <input
        id="tm-cert-expires"
        type="date"
        value={fields.expiresOn}
        onChange={(e) => set({ expiresOn: e.target.value })}
      />
      <label htmlFor="tm-cert-standards">Standards (optional)</label>
      <input
        id="tm-cert-standards"
        value={fields.standards}
        placeholder="Comma-separated, e.g. ISO 9001, GOTS 7.0"
        onChange={(e) => set({ standards: e.target.value })}
      />
      <FormActions
        busy={busy}
        saveLabel="Confirm certificate"
        error={error}
        onCancel={() => {
          setUpload(null);
          setError("");
        }}
      />
    </form>
  );
}

export function SitePanel({
  site,
  suppliers,
  floods,
  checkRadiusKm,
  onBack,
  onSupplier,
  onFlood,
  onEdit,
}: {
  site: MapSite;
  suppliers: SupplierGroup[];
  floods: FloodEntry[];
  checkRadiusKm: number;
  onBack: () => void;
  onSupplier: (name: string) => void;
  onFlood: (flood: SatelliteObservation) => void;
  onEdit?: (site: MapSite) => void;
}) {
  const near = floods.flatMap((f) =>
    f.sites
      .filter((s) => s.site.key === site.key)
      .map((s) => ({ flood: f.flood, km: s.km })),
  );
  return (
    <>
      <PanelHead
        eyebrow={`YOUR SITE · ${site.place.toUpperCase()}`}
        title={site.name + "."}
        sub={site.note}
        onBack={onBack}
      />
      {onEdit && (
        <button className="text-link tm-edit" onClick={() => onEdit(site)}>
          <Pencil size={13} />
          Edit site
        </button>
      )}
      {site.isRouteOrigin && (
        <p className="tm-muted">Order routes on the world map start here.</p>
      )}
      {near.map(({ flood, km }) => (
        <FloodCallout
          key={flood.id}
          flood={flood}
          detail={`${km} km from the observed edge. Check stock and road access.`}
          onOpen={() => onFlood(flood)}
        />
      ))}
      {!near.length && (
        <p className="tm-ok">
          <Check size={15} /> No matching observations in this dataset within{" "}
          {checkRadiusKm} km. This does not confirm that the site is unaffected.
        </p>
      )}
      {site.kind === "factory" && (
        <section className="tm-section">
          <h3>Company suppliers with open orders</h3>
          <ul className="tm-list">
            {suppliers
              .filter((s) => s.rows.length)
              .map((s) => (
                <li key={s.key}>
                  <button onClick={() => onSupplier(s.name)}>
                    <i className="tm-key supplier" />
                    <span>
                      <b>{s.name}</b>
                      <small>
                        {s.place ?? "Location not on file"} ·{" "}
                        {plural(s.rows.length, "order")}
                      </small>
                    </span>
                    <ArrowUpRight size={14} />
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}
    </>
  );
}
