import React, { useEffect, useState } from "react";
import { Check, Loader2, Trash2 } from "lucide-react";
import {
  api,
  type MapSite,
  type RequirementCheck,
  type SiteInput,
  type SupplierInput,
  type SupplierRecord,
  type TradeMap,
} from "../api";
import { errorMessage } from "../auth";
import {
  type LonLat,
  type Pin,
  type SupplierGroup,
  plural,
  supplierKey,
} from "./model";
import { PanelHead } from "./panels";

// Latitude first, the way map apps copy a point: "10.95, 106.82".
function parseLocation(text: string): LonLat | null | "invalid" {
  const value = text.trim();
  if (!value) return null;
  const match = /^(-?\d+(?:\.\d+)?)°?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)°?$/.exec(
    value,
  );
  if (!match) return "invalid";
  const lat = Number(match[1]),
    lon = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : "invalid";
}

const formatLocation = ([lon, lat]: LonLat) =>
  `${Number(lat.toFixed(5))}, ${Number(lon.toFixed(5))}`;

function LocationField({
  id,
  pin,
  required,
  mapless,
  onPin,
  onValid,
}: {
  id: string;
  pin: Pin | null;
  required?: boolean;
  mapless?: boolean; // the form is open away from the map (an order's page)
  onPin: (pin: Pin | null) => void;
  onValid: (valid: boolean) => void;
}) {
  const [text, setText] = useState(pin ? formatLocation(pin.at) : "");
  // A click on the map replaces whatever was typed.
  useEffect(() => {
    if (!pin?.picked) return;
    setText(formatLocation(pin.at));
    onValid(true);
  }, [pin?.picked]);
  const invalid = parseLocation(text) === "invalid";
  return (
    <>
      <label htmlFor={id}>Location{required ? "" : " (optional)"}</label>
      <input
        id={id}
        value={text}
        required={required}
        autoComplete="off"
        placeholder="10.95, 106.82"
        aria-invalid={invalid}
        aria-describedby={id + "-hint"}
        onChange={(e) => {
          setText(e.target.value);
          const next = parseLocation(e.target.value);
          onValid(next !== "invalid");
          onPin(
            next && next !== "invalid"
              ? { at: next, country: null, picked: pin?.picked ?? 0 }
              : null,
          );
        }}
      />
      <small id={id + "-hint"} className={invalid ? "tm-field-error" : ""}>
        {invalid
          ? "Write latitude, then longitude, for example 10.95, 106.82."
          : mapless
            ? "Paste latitude and longitude from a map app."
            : "Click the map, or paste latitude and longitude from a map app."}
      </small>
    </>
  );
}

function CountryField({
  id,
  value,
  countries,
  onChange,
}: {
  id: string;
  value: string;
  countries: TradeMap["countries"];
  onChange: (code: string) => void;
}) {
  return (
    <>
      <label htmlFor={id}>Country</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not set</option>
        {countries.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </select>
    </>
  );
}

export function FormActions({
  busy,
  saveLabel,
  error,
  onCancel,
}: {
  busy: boolean;
  saveLabel: string;
  error: string;
  onCancel: () => void;
}) {
  return (
    <>
      {error && (
        <p className="tm-field-error" role="alert">
          {error}
        </p>
      )}
      <div className="tm-form-actions">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
          {saveLabel}
        </button>
        <button className="text-link" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

function DeleteRecord({
  what,
  consequence,
  busy,
  onDelete,
}: {
  what: string;
  consequence: string;
  busy: boolean;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <button
        type="button"
        className="text-link tm-delete"
        onClick={() => setConfirming(true)}
      >
        <Trash2 size={13} />
        Delete {what}
      </button>
    );
  return (
    <div className="tm-confirm" role="group" aria-label={`Delete ${what}`}>
      <p>{consequence}</p>
      <div className="tm-form-actions">
        <button
          type="button"
          className="btn tm-danger"
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 size={15} />
          Delete {what}
        </button>
        <button
          type="button"
          className="text-link"
          onClick={() => setConfirming(false)}
        >
          Keep it
        </button>
      </div>
    </div>
  );
}

type DocumentDraft = {
  on: boolean;
  detail: string;
  standards: string;
  number: string;
  issuer: string;
  expiresOn: string;
};

// An order's supplier checks still to answer, and the order they come from: the form lists
// those documents first and says what the checklist accepts.
export type NeededDocuments = { orderId: string; checks: RequirementCheck[] };

export function SupplierForm({
  group,
  name: suggestedName,
  documentKinds,
  countries,
  pin,
  needed,
  mapless,
  onPin,
  onSaved,
  onDeleted,
  onCancel,
}: {
  group: SupplierGroup | null;
  name?: string;
  documentKinds: TradeMap["documentKinds"];
  countries: TradeMap["countries"];
  pin: Pin | null;
  needed?: NeededDocuments;
  mapless?: boolean;
  onPin: (pin: Pin | null) => void;
  // `saved.analysedOrderIds`: the orders the backend analysed again after the change.
  onSaved: (name: string, saved: SupplierRecord) => Promise<void>;
  onDeleted: (analysedOrderIds: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const record = group?.id ? group : null;
  const neededByKind = new Map(
    (needed?.checks ?? [])
      .filter((check) => check.documentKind)
      .map((check) => [check.documentKind!, check]),
  );
  const kinds = [
    ...documentKinds.filter(({ kind }) => neededByKind.has(kind)),
    ...documentKinds.filter(({ kind }) => !neededByKind.has(kind)),
  ];
  const [name, setName] = useState(group?.name ?? suggestedName ?? "");
  const [place, setPlace] = useState(record?.place ?? "");
  const [country, setCountry] = useState(record?.country ?? "");
  const [supplies, setSupplies] = useState(record?.supplies ?? "");
  const [contactName, setContactName] = useState(record?.contactName ?? "");
  const [contactEmail, setContactEmail] = useState(record?.contactEmail ?? "");
  const [documents, setDocuments] = useState<Record<string, DocumentDraft>>(
    () =>
      Object.fromEntries(
        documentKinds.map(({ kind }) => {
          const doc = record?.documents?.find((d) => d.kind === kind);
          return [
            kind,
            {
              on: !!doc,
              detail: doc?.detail ?? "",
              standards: doc?.standards.join(", ") ?? "",
              number: doc?.documentNumber ?? "",
              issuer: doc?.issuer ?? "",
              expiresOn: doc?.expiresOn ?? "",
            },
          ];
        }),
      ),
  );
  const [locationValid, setLocationValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (pin?.picked && pin.country) setCountry(pin.country);
  }, [pin?.picked]);
  const editDocument = (kind: string, change: Partial<DocumentDraft>) =>
    setDocuments((all) => ({ ...all, [kind]: { ...all[kind], ...change } }));
  const renamed =
    !!record && !!name.trim() && supplierKey(name) !== record.key;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!locationValid)
      return setError("Fix the location, or leave it empty.");
    const body: SupplierInput = {
      name: name.trim(),
      place: place.trim() || null,
      country: country || null,
      location: pin ? { latitude: pin.at[1], longitude: pin.at[0] } : null,
      supplies: supplies.trim() || null,
      contactName: contactName.trim() || null,
      contactEmail: contactEmail.trim() || null,
      documents: documentKinds
        .filter(({ kind }) => documents[kind].on)
        .map(({ kind }) => ({
          kind,
          detail: documents[kind].detail.trim(),
          standards: documents[kind].standards
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          documentNumber: documents[kind].number.trim() || null,
          issuer: documents[kind].issuer.trim() || null,
          expiresOn: documents[kind].expiresOn || null,
        })),
    };
    run(async () => {
      const saved = record
        ? await api.updateSupplier(record.id!, body)
        : await api.createSupplier(body);
      await onSaved(saved.name, saved);
    });
  };

  return (
    <form className="tm-form" onSubmit={submit}>
      <PanelHead
        eyebrow={record ? "EDIT SUPPLIER" : "NEW SUPPLIER"}
        title={record ? record.name + "." : "Add a supplier."}
        sub="Orders are matched to a supplier by name, ignoring case and spacing."
      />
      <label htmlFor="tm-supplier-name">Name</label>
      <input
        id="tm-supplier-name"
        required
        maxLength={300}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="As it's written on your orders"
      />
      {renamed && record.rows.length > 0 && (
        <small className="tm-field-error">
          {plural(record.rows.length, "order")} name “{record.name}”. After
          renaming, they won't be checked against this supplier.
        </small>
      )}
      <label htmlFor="tm-supplier-place">Place (optional)</label>
      <input
        id="tm-supplier-place"
        maxLength={200}
        value={place}
        onChange={(e) => setPlace(e.target.value)}
        placeholder="Town, province"
      />
      <CountryField
        id="tm-supplier-country"
        value={country}
        countries={countries}
        onChange={setCountry}
      />
      <LocationField
        id="tm-supplier-location"
        pin={pin}
        mapless={mapless}
        onPin={onPin}
        onValid={setLocationValid}
      />
      <label htmlFor="tm-supplier-supplies">What they supply (optional)</label>
      <textarea
        id="tm-supplier-supplies"
        maxLength={1000}
        value={supplies}
        onChange={(e) => setSupplies(e.target.value)}
        placeholder="e.g. Cotton yarn, printed labels"
      />
      <label htmlFor="tm-supplier-contact-name">Contact person (optional)</label>
      <input
        id="tm-supplier-contact-name"
        maxLength={200}
        value={contactName}
        onChange={(e) => setContactName(e.target.value)}
        placeholder="Nguyen Van Minh"
      />
      <label htmlFor="tm-supplier-contact-email">Contact email (optional)</label>
      <input
        id="tm-supplier-contact-email"
        type="email"
        maxLength={254}
        value={contactEmail}
        onChange={(e) => setContactEmail(e.target.value)}
        placeholder="sales@supplier.com"
      />
      <fieldset className="tm-doc-fields">
        <legend>Documents on file</legend>
        <small>
          Tick what this supplier has given you. Orders' market checklists are
          checked against it.
          {neededByKind.size > 0 &&
            ` The ${plural(neededByKind.size, "document")} ${needed!.orderId}'s checklist asks for ${neededByKind.size === 1 ? "is" : "are"} first.`}
        </small>
        {kinds.map(({ kind, label }) => {
          const doc = documents[kind];
          const check = neededByKind.get(kind);
          const accepted = check?.acceptedStandards ?? [];
          return (
            <div
              key={kind}
              className={
                "tm-doc-field" + (doc.on ? " on" : "") + (check ? " needed" : "")
              }
            >
              <label className="tm-check">
                <input
                  type="checkbox"
                  checked={doc.on}
                  onChange={(e) => editDocument(kind, { on: e.target.checked })}
                />
                {label}
                {check && (
                  <span className="tm-doc-needed">
                    Needed for {needed!.orderId}
                  </span>
                )}
              </label>
              {check && (check.status === "mismatch" || accepted.length > 0) && (
                <small className="tm-doc-hint">
                  {check.status === "mismatch"
                    ? check.note
                    : `Accepted: ${accepted.join(" or ")}.`}
                </small>
              )}
              {doc.on && (
                <>
                  <input
                    aria-label={`${label}: what's on file`}
                    required
                    maxLength={500}
                    value={doc.detail}
                    onChange={(e) =>
                      editDocument(kind, { detail: e.target.value })
                    }
                    placeholder="What's on file, e.g. Test report, Mar 2026"
                  />
                  <input
                    aria-label={`${label}: test standards`}
                    value={doc.standards}
                    onChange={(e) =>
                      editDocument(kind, { standards: e.target.value })
                    }
                    placeholder={
                      accepted.length
                        ? `Test standards, e.g. ${accepted[0]}`
                        : "Test standards, comma-separated (optional)"
                    }
                  />
                  <input
                    aria-label={`${label}: document number`}
                    maxLength={100}
                    value={doc.number}
                    onChange={(e) =>
                      editDocument(kind, { number: e.target.value })
                    }
                    placeholder="Document number (optional)"
                  />
                  <input
                    aria-label={`${label}: issuer`}
                    maxLength={200}
                    value={doc.issuer}
                    onChange={(e) =>
                      editDocument(kind, { issuer: e.target.value })
                    }
                    placeholder="Issued by (optional)"
                  />
                  <label className="tm-doc-expiry">
                    Expires on (optional)
                    <input
                      type="date"
                      aria-label={`${label}: expires on`}
                      value={doc.expiresOn}
                      onChange={(e) =>
                        editDocument(kind, { expiresOn: e.target.value })
                      }
                    />
                  </label>
                </>
              )}
            </div>
          );
        })}
      </fieldset>
      <FormActions
        busy={busy}
        saveLabel={record ? "Save supplier" : "Add supplier"}
        error={error}
        onCancel={onCancel}
      />
      {record && (
        <DeleteRecord
          what="supplier"
          busy={busy}
          consequence={`Delete ${record.name} and its documents? ${
            record.rows.length
              ? `Its ${plural(record.rows.length, "order")} stay, without a supplier record to check.`
              : ""
          }`}
          onDelete={() =>
            run(async () => {
              const deleted = await api.deleteSupplier(record.id!);
              await onDeleted(deleted.analysedOrderIds);
            })
          }
        />
      )}
    </form>
  );
}

const SITE_KINDS: { kind: MapSite["kind"]; label: string }[] = [
  { kind: "factory", label: "Factory" },
  { kind: "warehouse", label: "Warehouse" },
  { kind: "port", label: "Port" },
];

export function SiteForm({
  site,
  originName,
  countries,
  pin,
  onPin,
  onSaved,
  onDeleted,
  onCancel,
}: {
  site: MapSite | null;
  originName: string | null; // the site routes start from now, if any
  countries: TradeMap["countries"];
  pin: Pin | null;
  onPin: (pin: Pin | null) => void;
  onSaved: (key: string) => Promise<void>;
  onDeleted: () => Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<MapSite["kind"]>(site?.kind ?? "factory");
  const [name, setName] = useState(site?.name ?? "");
  const [shortName, setShortName] = useState(
    site && site.shortName !== site.name ? site.shortName : "",
  );
  const [place, setPlace] = useState(site?.place ?? "");
  const [country, setCountry] = useState(site?.country ?? "");
  const [note, setNote] = useState(site?.note ?? "");
  const [origin, setOrigin] = useState(
    site ? site.isRouteOrigin : !originName,
  );
  const [locationValid, setLocationValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (pin?.picked && pin.country) setCountry(pin.country);
  }, [pin?.picked]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!locationValid || !pin)
      return setError("Click the map where the site is, or enter its coordinates.");
    const body: SiteInput = {
      kind,
      name: name.trim(),
      shortName: shortName.trim() || name.trim().slice(0, 60).trim(),
      place: place.trim(),
      country: country || null,
      location: { latitude: pin.at[1], longitude: pin.at[0] },
      note: note.trim(),
      isRouteOrigin: origin,
    };
    run(async () => {
      const saved = site
        ? await api.updateSite(site.id, body)
        : await api.createSite(body);
      await onSaved(saved.key);
    });
  };
  const movesOrigin =
    origin && !site?.isRouteOrigin && originName && originName !== site?.name;

  return (
    <form className="tm-form" onSubmit={submit}>
      <PanelHead
        eyebrow={site ? "EDIT SITE" : "NEW SITE"}
        title={site ? site.name + "." : "Add a site."}
        sub="A factory, warehouse or port of your own."
      />
      <label htmlFor="tm-site-kind">Kind</label>
      <select
        id="tm-site-kind"
        value={kind}
        onChange={(e) => setKind(e.target.value as MapSite["kind"])}
      >
        {SITE_KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      <label htmlFor="tm-site-name">Name</label>
      <input
        id="tm-site-name"
        required
        maxLength={200}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Cat Lai bonded warehouse"
      />
      <label htmlFor="tm-site-short">Label on the map (optional)</label>
      <input
        id="tm-site-short"
        maxLength={60}
        value={shortName}
        onChange={(e) => setShortName(e.target.value)}
        placeholder={name.trim().slice(0, 60) || "Cat Lai"}
      />
      <label htmlFor="tm-site-place">Place</label>
      <input
        id="tm-site-place"
        required
        maxLength={200}
        value={place}
        onChange={(e) => setPlace(e.target.value)}
        placeholder="Ho Chi Minh City port"
      />
      <CountryField
        id="tm-site-country"
        value={country}
        countries={countries}
        onChange={setCountry}
      />
      <LocationField
        id="tm-site-location"
        pin={pin}
        required
        onPin={onPin}
        onValid={setLocationValid}
      />
      <label htmlFor="tm-site-note">Note (optional)</label>
      <textarea
        id="tm-site-note"
        maxLength={1000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Production and warehouses WH-1, WH-2."
      />
      <label className="tm-check">
        <input
          type="checkbox"
          checked={origin}
          onChange={(e) => setOrigin(e.target.checked)}
        />
        Order routes start here
      </label>
      <small>
        {movesOrigin
          ? `Routes start from ${originName} now. Saving moves the start here.`
          : "Routes on the world map, and route comparisons, start from one site."}
      </small>
      <FormActions
        busy={busy}
        saveLabel={site ? "Save site" : "Add site"}
        error={error}
        onCancel={onCancel}
      />
      {site && (
        <DeleteRecord
          what="site"
          busy={busy}
          consequence={`Delete ${site.name}?${
            site.isRouteOrigin
              ? " Routes start here; without it they start from your company profile's origin, or not at all."
              : ""
          }`}
          onDelete={() =>
            run(async () => {
              await api.deleteSite(site.id);
              await onDeleted();
            })
          }
        />
      )}
    </form>
  );
}
