import React, {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Plus,
  Bell,
  ChevronDown,
  Check,
  CheckCheck,
  X,
  Search,
  Upload,
  FileText,
  Globe2,
  ShieldCheck,
  Download,
  Play,
  Leaf,
  Settings2,
  Menu,
  Loader2,
  CircleAlert,
  Package,
  Send,
  Trash2,
  UserRound,
  LogOut,
  Newspaper,
  Map as MapIcon,
} from "lucide-react";
import {
  initialOrders,
  initialRules,
  money,
  date,
  readSaved,
  save,
  type Order,
  type Rule,
} from "./data";
import "./styles.css";
import Landing from "./Landing";
import AccountPage, { AccountSettings } from "./Account";
import {
  getProfile,
  hasSession,
  isApiSession,
  navigate,
  routeStops,
  placeCode,
} from "./account-store";
import ChatPage, { ChatWidget } from "../ai/chat/Chat";
import NewsWatchPage, { NewsHighlights } from "../ai/news/NewsWatch";
import {
  api,
  asOrder,
  cacheAccount,
  ApiError,
  type Account,
  type Overview,
  type ImportPreview,
  type OrderDetail,
} from "./api";
import { errorMessage } from "./auth";
import ErrorBoundary from "./ErrorBoundary";
import { MAX_UPLOAD_MB, validateOrderCsv } from "./order-csv";
const RegulationsPage = lazy(() => import("./Regulations"));
const TradeMapPage = lazy(() => import("./TradeMap"));
const nav = [
  ["", "Overview"],
  ["orders", "Orders"],
  ["map", "Trade map"],
  ["news", "News watch"],
  ["rules", "Rule watch"],
  ["regulations", "Regulations"],
  ["data", "Data room"],
  ["playbook", "Playbook"],
  ["account", "Account"],
];
const initialsOf = (text: string) =>
  text
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
const go = (path: string) => {
  window.location.hash = "/workspace/" + path;
  window.scrollTo({ top: 0, behavior: "instant" });
};
const Button = ({
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
function App() {
  const live = isApiSession();
  const [account, setAccount] = useState<Account | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(live);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const mutationRef = useRef(false);
  const [serverImport, setServerImport] = useState<ImportPreview | null>(null);
  const uploadVersion = useRef(0);
  const [serverDetail, setServerDetail] = useState<OrderDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const editable =
    !live || account?.role === "owner" || account?.role === "editor";
  const workspaceLoad = useRef<AbortController | null>(null);
  async function refreshWorkspace() {
    workspaceLoad.current?.abort();
    const controller = new AbortController();
    workspaceLoad.current = controller;
    const signal = controller.signal;
    setLoading(true);
    setLoadError("");
    try {
      const me = await api.me(signal);
      if (signal.aborted) return;
      setAccount(me);
      setProfile(cacheAccount(me));
      if (!me.onboarded) {
        navigate("onboarding");
        return;
      }
      const [nextOrders, nextRules, nextOverview] = await Promise.all([
        api.orders(signal),
        api.rules(signal),
        api.overview(signal),
      ]);
      if (signal.aborted) return;
      setOrders(nextOrders);
      setRules(nextRules);
      setOverview(nextOverview);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError && error.code === "onboarding_required")
        navigate("onboarding");
      setLoadError(errorMessage(error));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }
  async function mutate(action: () => Promise<void>) {
    if (mutationRef.current) return;
    mutationRef.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setToast(errorMessage(error), true);
    } finally {
      mutationRef.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (live) void refreshWorkspace();
    return () => workspaceLoad.current?.abort();
  }, [live]);
  const [profile, setProfile] = useState(getProfile);
  const initials = initialsOf(profile.name) || "EM";
  const companyInitials = initialsOf(profile.company) || "EM";
  const accessLabel = account?.role
    ? account.role[0].toUpperCase() + account.role.slice(1)
    : "";
  const now = new Date();
  const todayLabel =
    `${now.toLocaleDateString("en-GB", { weekday: "long" })}, ${now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`.toUpperCase();
  const [route, setRoute] = useState(
    location.hash.replace(/^#\/?/, "").replace(/^workspace\/?/, ""),
  );
  const [orders, setOrders] = useState<Order[]>(() =>
    live
      ? []
      : readSaved(
          "em-orders",
          initialOrders,
          (v) =>
            Array.isArray(v) &&
            v.length > 0 &&
            v.every(
              (o) =>
                o &&
                typeof o.id === "string" &&
                typeof o.product === "string" &&
                typeof o.supplier === "string" &&
                typeof o.destination === "string" &&
                typeof o.hsCode === "string" &&
                typeof o.shipDate === "string" &&
                typeof o.value === "number" &&
                Number.isFinite(o.value) &&
                typeof o.risk === "boolean",
            ),
        ),
  );
  const [rules, setRules] = useState<Rule[]>(() =>
    live
      ? []
      : readSaved(
          "em-rules",
          initialRules,
          (v) =>
            Array.isArray(v) &&
            v.every(
              (r) =>
                r &&
                typeof r.id === "string" &&
                typeof r.text === "string" &&
                typeof r.category === "string" &&
                typeof r.enabled === "boolean",
            ),
        ),
  );
  const [sent, setSent] = useState<string[]>(() =>
    readSaved(
      "em-sent",
      [],
      (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
    ),
  );
  const [buyer, setBuyer] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [toast, setToastState] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const setToast = (text: string, error = false) =>
    setToastState(text ? { text, error } : null);
  const [modal, setModal] = useState<"demo" | "message" | "evidence" | null>(
    null,
  );
  const [selected, setSelected] = useState<Order>(
    orders[0] || initialOrders[0],
  );
  const [demoStep, setDemoStep] = useState(-1);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All orders");
  const [ruleText, setRuleText] = useState("");
  // First click on a rule's delete button asks for a second click to confirm.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(null), 5000);
    return () => clearTimeout(t);
  }, [confirmDelete]);
  const [category, setCategory] = useState("Policy");
  const [preview, setPreview] = useState<Order[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const fn = () => {
      setRoute(location.hash.replace(/^#\/?/, "").replace(/^workspace\/?/, ""));
      setMobile(false);
    };
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  useEffect(() => {
    if (!live) save("em-orders", orders);
  }, [orders, live]);
  useEffect(() => {
    if (!live) save("em-rules", rules);
  }, [rules, live]);
  useEffect(() => save("em-sent", sent), [sent]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToastState(null), toast.error ? 9000 : 4500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  // The running demo can't be dismissed; a ref so focus handling doesn't re-run each step.
  const demoRunning = useRef(false);
  useEffect(() => {
    demoRunning.current = modal === "demo" && demoStep < 6;
  }, [modal, demoStep]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !demoRunning.current) setModal(null);
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
  }, [modal]);
  useEffect(() => {
    if (modal === "demo" && demoStep >= 0 && demoStep < 6) {
      const t = setTimeout(() => {
        if (demoStep === 5) {
          setOrders((v) => [
            ...initialOrders,
            ...v.filter((o) => !initialOrders.some((seed) => seed.id === o.id)),
          ]);
          setSent([]);
        }
        setDemoStep((x) => x + 1);
      }, 1000);
      return () => clearTimeout(t);
    }
  }, [modal, demoStep]);
  useEffect(() => {
    setServerDetail(null);
    setDetailError("");
    if (!live || !route.startsWith("orders/")) return;
    let active = true;
    api
      .detail(decodeURIComponent(route.slice(7)))
      .then((value) => {
        if (active) setServerDetail(value);
      })
      .catch((error) => {
        if (active) setDetailError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [route, live]);
  const isSeed = (o: Order) => initialOrders.some((seed) => seed.id === o.id);
  const isClear = (o: Order) =>
    live ? o.status === "clear" : !o.risk && isSeed(o);
  const isPending = (o: Order) =>
    live ? o.status === "awaiting_analysis" : !isSeed(o);
  const clearOrders = orders.filter(isClear);
  const pendingOrders = orders.filter(isPending);
  const exposed = orders.filter((o) => o.risk);
  const atRisk = exposed.length * (buyer ? 7400 : 1200);
  const currency = buyer ? "SGD" : "USD";
  const startDemo = () => {
    if (live) {
      setToast(
        "The rule-change simulation is available in the sample demo. Your server records are unchanged.",
      );
      return;
    }
    setOrders((v) =>
      v.map((o) =>
        initialOrders.some((seed) => seed.id === o.id)
          ? { ...o, risk: false }
          : o,
      ),
    );
    setSent([]);
    setDemoStep(0);
    setModal("demo");
  };
  const openMessage = (o: Order) => {
    setSelected(o);
    setMessage(
      `Hello ${o.supplier},\n\nWe’re preparing ${o.id} (${o.product}) for shipment on ${date(o.shipDate)} to ${o.destination}.\n\nPlease share the plot-level geolocation data and supporting origin records for the acacia used in this order. We need these to review the documentation for our EU-bound shipment.\n\nCould you confirm availability and an expected delivery date?\n\nThank you,\n${profile.name} · ${profile.company || "Your company"}`,
    );
    setModal("message");
  };
  const download = (name: string, content: string, type = "text/csv") => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const parseFile = async (file?: File) => {
    if (!editable) {
      setToast("Only company owners and editors can import orders.", true);
      return;
    }
    if (busy) return;
    const version = ++uploadVersion.current;
    setServerImport(null);
    if (!file) return;
    setPreview([]);
    setFileName(file.name);
    setImportErrors([]);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setImportErrors([
        "Please choose a CSV file. Excel, photo, and PDF processing will be available with the backend.",
      ]);
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setImportErrors([`File must be smaller than ${MAX_UPLOAD_MB} MB.`]);
      return;
    }
    if (live) {
      setBusy(true);
      try {
        const uploaded = await api.upload(file);
        const result = await api.import(uploaded.id);
        if (version !== uploadVersion.current) return;
        setServerImport(result);
        setImportErrors(
          result.errors.map(
            (e) =>
              `${e.row ? `Row ${e.row}: ` : ""}${e.field ? `${e.field}: ` : ""}${e.message}`,
          ),
        );
        setPreview(
          result.preview.map((row) =>
            asOrder({ ...row, status: "awaiting_analysis" }),
          ),
        );
      } catch (error) {
        setImportErrors([errorMessage(error)]);
      } finally {
        setBusy(false);
      }
      return;
    }
    const { default: Papa } = await import("papaparse");
    if (version !== uploadVersion.current) return;
    Papa.parse<Record<string, string | undefined>>(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h) => h.trim(),
      complete: (r) => {
        const result = validateOrderCsv(
          r.meta.fields,
          r.data,
          new Set(orders.map((o) => o.id)),
        );
        const errors = [
          ...r.errors.map((e) => `CSV: ${e.message}`),
          ...result.errors,
        ];
        setImportErrors(errors);
        if (!errors.length) setPreview(result.orders);
      },
      error: (e) => setImportErrors([e.message]),
    });
  };
  async function commitImport() {
    if (!live) {
      setOrders((v) => [...v, ...preview]);
      setToast(`${preview.length} orders imported in the sample demo.`);
    } else {
      if (!serverImport || serverImport.status !== "validated") return;
      const result = await api.commit(serverImport.id);
      // Clear the committed upload even if the subsequent refresh fails.
      setServerImport(null);
      setPreview([]);
      setFileName("");
      setToast(`${result.ordersCreated} orders imported. Awaiting analysis.`);
      await refreshWorkspace();
    }
    setPreview([]);
    setFileName("");
    go("orders");
  }
  const riskDisplay = live
    ? Object.entries(overview?.valueAtRiskByCurrency || {})
        .map(([code, minor]) => money(minor / 100, code))
        .join(" + ") || "—"
    : money(atRisk, currency);
  const status = (o: Order) => (
    <span
      className={`status ${o.risk ? "red" : isClear(o) ? "green" : "amber"}`}
    >
      <i />
      {o.risk
        ? "Action needed"
        : isClear(o)
          ? "In the clear"
          : o.status === "needs_data"
            ? "Needs data"
            : "Awaiting analysis"}
    </span>
  );
  const orderTable = (items: Order[]) => (
    <div className="table-scroll">
      <table className="orders-table">
        <thead>
          <tr>
            <th>Order / product</th>
            <th>Supplier</th>
            <th>Destination</th>
            <th>Order value</th>
            <th>Ships</th>
            <th>Status</th>
            <th>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id}>
              <td>
                <button
                  className="order-link"
                  onClick={() => go("orders/" + encodeURIComponent(o.id))}
                >
                  {o.id}
                </button>
                <small>{o.product}</small>
              </td>
              <td data-label="Supplier">{o.supplier}</td>
              <td data-label="Destination">{o.destination}</td>
              <td data-label="Order value" className="mono">
                {money(o.value, o.currency)}
              </td>
              <td data-label="Ships">{date(o.shipDate)}</td>
              <td data-label="Status">{status(o)}</td>
              <td className="order-open">
                <button
                  className="icon-btn"
                  aria-label={`View ${o.id}`}
                  onClick={() => go("orders/" + encodeURIComponent(o.id))}
                >
                  <ArrowUpRight size={18} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <div className="empty">
          No orders match your search. Try another order, supplier, or
          destination.
        </div>
      )}
    </div>
  );
  const detail =
    live && serverDetail
      ? asOrder(serverDetail.order)
      : orders.find((o) => route === "orders/" + encodeURIComponent(o.id));
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#/">
          <span className="brand-symbol">
            E<ArrowUpRight size={21} />
          </span>
          ExportMate<span className="brand-dot">®</span>
        </a>
        <div className="workspace">
          <span className="company-mark">{companyInitials}</span>
          <div>
            <strong>{profile.company || "Your company"}</strong>
            <small>{profile.role} workspace</small>
          </div>
        </div>
        <div className="nav-label">YOUR WORKSPACE</div>
        <nav>
          {nav.map(([path, label], i) => {
            const Icon = [
              Globe2,
              Package,
              MapIcon,
              Newspaper,
              ShieldCheck,
              FileText,
              Upload,
              Settings2,
              UserRound,
            ][i];
            return (
              <a
                className={
                  (route.split("/")[0] === path ? "active " : "") + "nav-item"
                }
                href={"#/workspace/" + path}
                key={path}
                onClick={() => path === "orders" && setFilter("All orders")}
              >
                <Icon size={18} />
                {label}
                {path === "orders" && (
                  <span className="nav-count">{orders.length}</span>
                )}
                {path === "rules" && !live && exposed.length > 0 && (
                  <span className="nav-dot" />
                )}
              </a>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="watching">
            <span className="pulse" /> Your trade corridor.
            <p>
              {profile.origin} to {profile.destination}.
            </p>
            <div className="mini-corridor">
              {routeStops(profile).map((place, i) => (
                <Fragment key={i}>
                  {i > 0 && <span>→</span>}
                  {placeCode(place)}
                </Fragment>
              ))}
            </div>
          </div>
          <button className="profile" onClick={() => go("account")}>
            <span className="avatar">{buyer ? "JT" : initials}</span>
            <span>
              <strong>{buyer ? "James Tan" : profile.name}</strong>
              <small>
                {buyer
                  ? "Buyer perspective"
                  : live
                    ? accessLabel || "Member"
                    : `${profile.role} · sample`}
              </small>
            </span>
            <ArrowUpRight size={15} />
          </button>
          <a className="workspace-signout" href="#/logout">
            <LogOut size={14} />
            Sign out
          </a>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="mobile-menu icon-btn"
            aria-label="Toggle navigation"
            aria-expanded={mobile}
            aria-controls="mobile-nav"
            onClick={() => setMobile(!mobile)}
          >
            <Menu />
          </button>
          <div className="breadcrumb">
            Workspace <span>/</span>{" "}
            <strong>
              {detail
                ? "Order impact"
                : nav.find(([p]) => p === route.split("/")[0])?.[1] ||
                  "Overview"}
            </strong>
          </div>
          <div className="top-actions">
            <span className="demo-badge">
              {live ? "CONNECTED WORKSPACE" : "DEMO WORKSPACE"}
            </span>
            {!live && (
              <button className="perspective" onClick={() => setBuyer(!buyer)}>
                {buyer ? "Buyer view" : "Maker view"}
                <ChevronDown size={13} />
              </button>
            )}
            <button
              className="notification icon-btn"
              aria-label="View alerts"
              onClick={() => {
                go("orders");
                setFilter("Action needed");
              }}
            >
              <Bell size={18} />
              {exposed.length > 0 && <i />}
            </button>
            <button
              className="avatar small"
              onClick={() => go("account")}
              aria-label="Account settings"
            >
              {buyer ? "JT" : initials}
            </button>
          </div>
        </header>
        {mobile && (
          <nav className="mobile-nav" id="mobile-nav" aria-label="Workspace">
            {nav.map(([p, l]) => (
              <a
                key={p}
                href={"#/workspace/" + p}
                className={route.split("/")[0] === p ? "active" : ""}
                aria-current={route.split("/")[0] === p ? "page" : undefined}
                onClick={() => {
                  setMobile(false);
                  if (p === "orders") setFilter("All orders");
                }}
              >
                {l}
              </a>
            ))}
            <a className="mobile-signout" href="#/logout">
              <LogOut size={13} />
              Sign out
            </a>
          </nav>
        )}
        <main>
          {live && loading ? (
            <section className="panel" role="status">
              <Loader2 size={20} /> Loading your workspace…
            </section>
          ) : live && loadError ? (
            <section className="panel" role="alert">
              <h2>Couldn’t load your workspace.</h2>
              <p>{loadError}</p>
              <Button onClick={() => void refreshWorkspace()}>Try again</Button>
              <a className="text-link" href="#/login">
                Sign in again
              </a>
            </section>
          ) : (
            <ErrorBoundary resetKey={route}>
              {route === "" && (
                <>
                  <div className="eyebrow greeting">
                    <span>YOUR TRADE, IN THE CLEAR.</span>
                    {live ? (
                      <span>{todayLabel}</span>
                    ) : (
                      <span>
                        THURSDAY, 08 OCT 2026{" "}
                        <span className="muted">· SAMPLE DAY</span>
                      </span>
                    )}
                  </div>
                  <section className="hero-heading">
                    <div>
                      <h1>
                        YOUR TRADE.
                        <br />
                        <b>AT A GLANCE.</b>
                      </h1>
                    </div>
                    <div className="hero-copy">
                      <p>Order risks. Clear next steps.</p>
                      <button className="text-link" onClick={startDemo}>
                        Run demo <ArrowUpRight size={18} />
                      </button>
                    </div>
                  </section>
                  <section className="port-hero">
                    <img
                      src="/port.jpg"
                      alt="Shipping containers and cranes at an international cargo port"
                    />
                    <div className="port-overlay" />
                    <div className="port-top">
                      <span>
                        <i className="live-dot" /> YOUR CORRIDOR. CONNECTED.
                      </span>
                      <span className="image-label">01 / GLOBAL TRADE</span>
                    </div>
                    <div className="port-bottom">
                      <div>
                        <div className="corridor">
                          {routeStops(profile).map((place, i) => (
                            <Fragment key={i}>
                              {i > 0 && <ArrowRight />}
                              <span>{place}</span>
                            </Fragment>
                          ))}
                        </div>
                        <p>Your first trade corridor.</p>
                      </div>
                      <button
                        onClick={() => go("map")}
                        className="port-button"
                      >
                        Explore your corridor <ArrowUpRight size={18} />
                      </button>
                    </div>
                  </section>
                  <section className="metrics">
                    <div>
                      <span className="metric-label">
                        OPEN ORDERS <Package size={15} />
                      </span>
                      <div className="metric-value">
                        {String(
                          live
                            ? (overview?.totalOrders ?? orders.length)
                            : orders.length,
                        ).padStart(2, "0")}
                        <span>across your corridor</span>
                      </div>
                      <div className="metric-note">
                        <i className="dot green-dot" />
                        {clearOrders.length} in the clear
                        {pendingOrders.length > 0
                          ? ` · ${pendingOrders.length} awaiting analysis`
                          : ""}
                      </div>
                    </div>
                    <div>
                      <span className="metric-label">
                        NEED YOUR ATTENTION <CircleAlert size={15} />
                      </span>
                      <div className="metric-value danger">
                        {String(exposed.length).padStart(2, "0")}
                        <span>orders affected</span>
                      </div>
                      <div className="metric-note">
                        {live
                          ? `${overview?.countsByStatus.needs_data || 0} orders need more data`
                          : exposed.length
                            ? "One documentation gap. A clear next step."
                            : "You’re all clear for now."}
                      </div>
                    </div>
                    <div>
                      <span className="metric-label">
                        {live
                          ? "EXPOSED ORDER VALUE"
                          : "ESTIMATED VALUE AT RISK"}{" "}
                        <ArrowUpRight size={15} />
                      </span>
                      <div className="metric-value">
                        {riskDisplay}
                        <span>{live ? "by currency" : currency}</span>
                      </div>
                      <div className="metric-note">
                        {live
                          ? "Full order values; not estimated extra costs"
                          : buyer
                            ? "Buyer margin exposure"
                            : "Avoidable documentation & delay costs"}
                      </div>
                    </div>
                    <div>
                      <span className="metric-label">
                        NEXT AFFECTED SHIPMENT <Globe2 size={15} />
                      </span>
                      <div className="metric-value">
                        {live
                          ? overview?.nearestAffectedShipDate
                            ? date(overview.nearestAffectedShipDate)
                            : "—"
                          : exposed.length
                            ? "19"
                            : "—"}
                        <span>
                          {live
                            ? "next affected ship date"
                            : exposed.length
                              ? "days to prepare"
                              : "no action needed"}
                        </span>
                      </div>
                      <div className="metric-note">
                        {live
                          ? "Reported by your workspace"
                          : exposed.length
                            ? "27 Oct · Rotterdam, Netherlands"
                            : "No exposed shipments in this scenario"}
                      </div>
                    </div>
                  </section>
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">PRIORITY ACTIONS</span>
                      <h2>Your next move.</h2>
                    </div>
                    <button
                      className="text-link"
                      onClick={() => {
                        setFilter("Action needed");
                        go("orders");
                      }}
                    >
                      View all alerts <ArrowUpRight size={16} />
                    </button>
                  </div>
                  <div className="overview-grid">
                    <section className="action-card">
                      <div className="action-top">
                        <span
                          className={`status ${exposed.length ? "red" : "green"}`}
                        >
                          <i />
                          {exposed.length ? "ACTION NEEDED" : "ALL CLEAR"}
                        </span>
                        <span className="mono muted">
                          {live
                            ? routeStops(profile).map(placeCode).join(" · ")
                            : "EU · WOOD PRODUCTS"}
                        </span>
                      </div>
                      <h3>
                        {live
                          ? exposed.length
                            ? "Review affected orders."
                            : pendingOrders.length
                              ? "Orders awaiting analysis."
                              : "Your order status."
                          : exposed.length
                            ? "Geolocation data missing."
                            : "Your orders are looking good."}
                      </h3>
                      <p>
                        {live
                          ? "Order status comes from the backend. Exposure reports and supplier actions are not available yet."
                          : exposed.length
                            ? "Binh Phu Wood must provide geolocation records for two EU-bound orders."
                            : "Run the sample rule change to see how ExportMate connects a new obligation to your open orders."}
                      </p>
                      <div className="order-tags">
                        {exposed.slice(0, 2).map((o) => (
                          <button
                            key={o.id}
                            onClick={() =>
                              go("orders/" + encodeURIComponent(o.id))
                            }
                          >
                            {o.id}
                            <ArrowUpRight size={12} />
                          </button>
                        ))}
                        {exposed.length > 0 && (
                          <span>{riskDisplay} at risk</span>
                        )}
                      </div>
                      <div className="action-footer">
                        <span>
                          <ShieldCheck size={16} />{" "}
                          {live
                            ? "Server-backed order status"
                            : "Evidence linked · sample scenario"}
                        </span>
                        <Button
                          onClick={() =>
                            exposed.length
                              ? go(
                                  "orders/" + encodeURIComponent(exposed[0].id),
                                )
                              : live
                                ? go("orders")
                                : startDemo()
                          }
                        >
                          {exposed.length
                            ? "Review impact"
                            : live
                              ? "View orders"
                              : "Run the demo"}
                          <ArrowUpRight size={16} />
                        </Button>
                      </div>
                    </section>
                    <section className="quiet-card">
                      <div className="quiet-icon">
                        <Leaf size={26} />
                      </div>
                      <span className="eyebrow">RULE COVERAGE</span>
                      <h3>
                        Your corridor,
                        <br />
                        monitored.
                      </h3>
                      <p>
                        Only changes that touch your business make it to your
                        desk.
                      </p>
                      <div className="coverage">
                        <span>
                          <i className="pulse" />3 sample source collections
                        </span>
                        <button
                          className="text-link"
                          onClick={() => go("rules")}
                        >
                          Rule watch <ArrowUpRight size={15} />
                        </button>
                      </div>
                    </section>
                  </div>
                  <ErrorBoundary fallback={null}>
                    <NewsHighlights live={live} />
                  </ErrorBoundary>
                  <div className="section-heading order-section">
                    <h2>Orders on the move.</h2>
                    <button className="text-link" onClick={() => go("orders")}>
                      All {orders.length} orders <ArrowUpRight size={16} />
                    </button>
                  </div>
                  {orderTable(orders.slice(0, 4))}
                </>
              )}
              {route === "orders" && (
                <>
                  <PageHeading
                    label="EVERY ORDER. A CLEARER PICTURE."
                    title="Your orders."
                    description="Track orders and exposure."
                    action={
                      <Button onClick={() => go("data")}>
                        <Plus size={17} />
                        Import orders
                      </Button>
                    }
                  />
                  <div className="summary-strip">
                    <span>
                      <b>{orders.length}</b> open orders
                    </span>
                    <span>
                      <b className="danger">{exposed.length}</b> need attention
                    </span>
                    <span>
                      <b>{riskDisplay}</b>{" "}
                      {live ? "exposed order value" : "estimated at risk"}
                    </span>
                  </div>
                  <div className="toolbar">
                    <div className="tabs">
                      {[
                        "All orders",
                        "Action needed",
                        "In the clear",
                        "Awaiting analysis",
                        ...(live ? ["Needs data"] : []),
                      ].map((f) => (
                        <button
                          key={f}
                          className={filter === f ? "selected" : ""}
                          aria-pressed={filter === f}
                          onClick={() => setFilter(f)}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                    <label className="search">
                      <Search size={17} />
                      <input
                        aria-label="Search orders"
                        placeholder="Search orders, suppliers…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </label>
                  </div>
                  {orderTable(
                    orders.filter(
                      (o) =>
                        (filter === "All orders" ||
                          (filter === "Action needed"
                            ? o.risk
                            : filter === "Awaiting analysis"
                              ? isPending(o)
                              : filter === "Needs data"
                                ? o.status === "needs_data"
                                : isClear(o))) &&
                        `${o.id} ${o.product} ${o.supplier} ${o.destination}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                    ),
                  )}
                </>
              )}
              {detail && (
                <>
                  <button
                    className="text-link back"
                    onClick={() => go("orders")}
                  >
                    <ArrowLeft size={16} />
                    All orders
                  </button>
                  <PageHeading
                    label={
                      live
                        ? "ORDER DETAIL / YOUR COMPANY DATA"
                        : "ORDER IMPACT / SAMPLE ANALYSIS"
                    }
                    title={detail.id + "."}
                    description={detail.product + " · " + detail.destination}
                    action={status(detail)}
                  />
                  <div className="detail-meta">
                    <div>
                      <small>SUPPLIER</small>
                      <b>{detail.supplier}</b>
                    </div>
                    <div>
                      <small>SHIP DATE</small>
                      <b>
                        {date(detail.shipDate)} {detail.shipDate.slice(0, 4)}
                      </b>
                    </div>
                    <div>
                      <small>ORDER VALUE</small>
                      <b>{money(detail.value, detail.currency)}</b>
                    </div>
                    <div>
                      <small>HS CODE</small>
                      <b>{detail.hsCode}</b>
                    </div>
                  </div>
                  {live && (
                    <button
                      className="text-link order-map-link"
                      onClick={() =>
                        go("map/order/" + encodeURIComponent(detail.id))
                      }
                    >
                      <MapIcon size={15} />
                      If this order went to another market, what would change?
                      <ArrowUpRight size={15} />
                    </button>
                  )}
                  {live ? (
                    <section className="panel">
                      <h2>Source and analysis</h2>
                      {detailError ? (
                        <p role="alert">{detailError}</p>
                      ) : !serverDetail ? (
                        <p role="status">Loading order source…</p>
                      ) : (
                        <>
                          <p>
                            Exposure reports and supplier actions are not
                            available in the current backend.
                          </p>
                          {serverDetail.source ? (
                            <>
                              <h3>Original CSV row</h3>
                              <p>
                                Import {serverDetail.source.importId} · row{" "}
                                {serverDetail.source.rowNumber}
                              </p>
                              <dl className="evidence-data">
                                {Object.entries(serverDetail.source.raw).map(
                                  ([key, value]) => (
                                    <React.Fragment key={key}>
                                      <dt>{key}</dt>
                                      <dd>{value}</dd>
                                    </React.Fragment>
                                  ),
                                )}
                              </dl>
                            </>
                          ) : (
                            <p>No source CSV row is attached to this order.</p>
                          )}
                        </>
                      )}
                    </section>
                  ) : detail.risk ? (
                    <div className="detail-grid">
                      <section className="panel">
                        <span className="eyebrow danger">
                          01 / WHAT CHANGED
                        </span>
                        <h2>
                          A documentation gap.
                          <br />
                          An actionable next step.
                        </h2>
                        <p>
                          The sample obligation requires plot-level geolocation
                          for acacia in EU-bound wood products. Your supplier
                          record has no geolocation document for this lot.
                        </p>
                        <button
                          className="evidence-link"
                          onClick={() => {
                            setSelected(detail);
                            setModal("evidence");
                          }}
                        >
                          <FileText size={19} />
                          <span>
                            Review the source & your data
                            <small>
                              Sample clause §9 · orders.csv / {detail.id}
                            </small>
                          </span>
                          <ArrowUpRight size={18} />
                        </button>
                        <h3>The cost of waiting</h3>
                        <div className="cost-row">
                          <span>Documentation preparation</span>
                          <b>$400</b>
                        </div>
                        <div className="cost-row">
                          <span>Potential delay · 4 days × $200</span>
                          <b>$800</b>
                        </div>
                        <div className="cost-row total">
                          <span>Estimated maker exposure</span>
                          <b>$1,200 USD</b>
                        </div>
                        <p className="fine-print">
                          Illustrative estimate, not a tariff or guaranteed
                          cost. Documentation $400 + potential delay $800. Order
                          value is not added to this estimate.
                        </p>
                        {buyer && (
                          <div className="notice">
                            Buyer scenario: S$7,400 margin exposure per affected
                            purchase order. This is a separate seeded estimate,
                            not a currency conversion.
                          </div>
                        )}
                        <h3>How we got here</h3>
                        <div className="trace-inline">
                          {[
                            "Relevance",
                            "Exposure",
                            "Cost",
                            "Plan",
                            "Auditor",
                          ].map((s) => (
                            <span key={s}>
                              <Check size={13} />
                              {s}
                            </span>
                          ))}
                        </div>
                        <p className="fine-print">
                          Simulated reasoning. An unsupported
                          alternative-supplier claim was rejected by the auditor
                          and removed.
                        </p>
                      </section>
                      <aside className="recommendation">
                        <span className="eyebrow">02 / YOUR NEXT MOVE</span>
                        <div className="quiet-icon">
                          <Send size={24} />
                        </div>
                        <h2>
                          Start with{" "}
                          <br />
                          your supplier.
                        </h2>
                        <p>
                          Request plot-level geolocation and supporting origin
                          records from {detail.supplier}.
                        </p>
                        <div className="recommendation-meta">
                          <span>Suggested owner</span>
                          <b>{profile.name}</b>
                          <span>Priority</span>
                          <b>Before shipment</b>
                          <span>Channel</span>
                          <b>Zalo · demo</b>
                        </div>
                        <Button onClick={() => openMessage(detail)}>
                          {sent.includes(detail.id)
                            ? "Review message again"
                            : "Review supplier message"}
                          <ArrowUpRight size={17} />
                        </Button>
                        {sent.includes(detail.id) && (
                          <p className="sent-note">
                            <CheckCheck size={16} />
                            Message confirmed in demo
                          </p>
                        )}
                        <p className="fine-print">
                          You review and confirm every action. A message request
                          does not clear the underlying risk.
                        </p>
                      </aside>
                    </div>
                  ) : (
                    <section className="panel clear-panel">
                      <ShieldCheck size={44} />
                      <h2>
                        {initialOrders.some((o) => o.id === detail.id)
                          ? "In the clear."
                          : "Imported. Ready for review."}
                      </h2>
                      <p>
                        {initialOrders.some((o) => o.id === detail.id)
                          ? "No matching obligation in this sample scenario."
                          : "This order is stored in your browser. Live exposure analysis requires the backend."}
                      </p>
                      <Button onClick={() => go("orders")}>
                        Back to orders
                        <ArrowRight size={16} />
                      </Button>
                    </section>
                  )}
                </>
              )}
              {route.split("/")[0] === "map" && (
                <Suspense
                  fallback={
                    <section className="panel" role="status">
                      <Loader2 size={20} /> Loading the map…
                    </section>
                  }
                >
                  <TradeMapPage
                    key={route}
                    live={live}
                    focus={route.slice(4)}
                    toneOf={(o) =>
                      o.risk ? "red" : isClear(o) ? "green" : "amber"
                    }
                    renderStatus={status}
                    onNavigate={go}
                    signature={`${profile.name} · ${profile.company || "Your company"}`}
                    companyOrigin={profile.origin}
                  />
                </Suspense>
              )}
              {route.split("/")[0] === "regulations" && (
                <Suspense fallback={<section className="panel" role="status">Loading regulations…</section>}>
                  <RegulationsPage key={route} live={live} editable={editable} path={route.slice("regulations".length)} />
                </Suspense>
              )}
              {route === "news" && (
                <NewsWatchPage
                  live={live}
                  sourcesLocked={
                    !live
                      ? "Sign in to a company workspace to add or switch off sources."
                      : editable
                        ? undefined
                        : "Only company owners and editors can change sources."
                  }
                  scanLocked={
                    !live
                      ? "Sign in to a company workspace to run a scan."
                      : editable
                        ? undefined
                        : "Only company owners and editors can run a scan."
                  }
                />
              )}
              {route === "rules" && (
                <>
                  <PageHeading
                    label="THE WORLD CHANGES. STAY AHEAD."
                    title="Rule watch."
                    description="Changes affecting your products and markets."
                    action={
                      <Button onClick={startDemo}>
                        <Play size={16} />
                        Run rule-change demo
                      </Button>
                    }
                  />
                  <div className="notice">
                    <ShieldCheck size={18} />
                    Sample rule-change scenario. For stored official texts and
                    versioned references, open the regulation library.
                  </div>
                  <a className="text-link" href="#/workspace/regulations">
                    Open regulation library <ArrowUpRight size={16} />
                  </a>
                  <div className="fine-print">
                    Automated regulation analysis is not available yet.
                  </div>
                  <div className="source-grid">
                    {[
                      [
                        "EU",
                        "European Union",
                        "Wood & deforestation",
                        "EUR-Lex",
                      ],
                      [
                        "VN",
                        "Vietnam",
                        "Origin & export documentation",
                        "Government law portal",
                      ],
                      [
                        "SG",
                        "Singapore",
                        "Customs & re-export",
                        "Singapore Customs",
                      ],
                    ].map(([code, name, scope, source]) => (
                      <section className="source-card" key={code}>
                        <span className="country-code">{code}</span>
                        <span className="status green">
                          <i />
                          Sample source
                        </span>
                        <h3>{name}</h3>
                        <p>{scope}</p>
                        <div className="source-foot">
                          <span>{source}</span>
                          <Globe2 size={17} />
                        </div>
                      </section>
                    ))}
                  </div>
                  <div className="section-heading">
                    <h2>One change. The full picture.</h2>
                    <span className="eyebrow">ILLUSTRATIVE OBLIGATION</span>
                  </div>
                  <section className="panel">
                    <div className="rule-change-title">
                      <h3>Geolocation documentation for EU-bound wood</h3>
                      <span
                        className={`status ${exposed.length ? "red" : "green"}`}
                      >
                        <i />
                        {exposed.length} orders affected
                      </span>
                    </div>
                    <div className="diff-grid">
                      <div>
                        <span className="eyebrow">PREVIOUS SAMPLE</span>
                        <p>
                          Supplier-level origin documentation is present in the
                          firm's existing records.
                        </p>
                      </div>
                      <div>
                        <span className="eyebrow">NEW SAMPLE REQUIREMENT</span>
                        <p>
                          Provide <mark>plot-level geolocation</mark> for the
                          acacia used in each affected lot.
                        </p>
                      </div>
                    </div>
                    <div className="action-footer">
                      <span>HS 4412.33 · Vietnam → Singapore → EU</span>
                      <button
                        className="text-link"
                        onClick={() => {
                          setFilter("Action needed");
                          go("orders");
                        }}
                      >
                        See affected orders
                        <ArrowUpRight size={17} />
                      </button>
                    </div>
                  </section>
                </>
              )}
              {route === "data" && (
                <>
                  <PageHeading
                    label="YOUR DATA. THE START OF SOMETHING CLEARER."
                    title="Import your data."
                    description="Start with an orders CSV."
                    action={<a className="btn secondary" href="#/workspace/regulations">Regulation documents <FileText size={16} /></a>}
                  />
                  <div className="data-grid">
                    <section
                      className="upload-zone"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        void parseFile(e.dataTransfer.files[0]);
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
                          Only company owners and editors can import orders.
                          Ask your company owner for editor access.
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
                          void parseFile(e.target.files?.[0]);
                          e.target.value = "";
                        }}
                      />
                      <button
                        className="text-link template"
                        onClick={() =>
                          download(
                            "exportmate-orders-template.csv",
                            'id,product,supplier,destination,value,shipDate,hsCode,currency\nPO-2400,Acacia plywood,Binh Phu Wood,"Rotterdam, NL",24000,2026-11-15,4412.33,USD\n',
                          )
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
                        Less setup.{" "}
                        <br />
                        More clarity.
                      </h3>
                      <p>For each order, include:</p>
                      <ul>
                        <li>Order ID and product</li>
                        <li>Supplier and destination</li>
                        <li>
                          Order value (optional currency column, e.g. USD;
                          otherwise{" "}
                          {live
                            ? `your company currency, ${account?.company?.currency || "USD"}`
                            : "USD"}
                          )
                        </li>
                        <li>Ship date and HS code</li>
                      </ul>
                      <p className="fine-print">
                        Coming with the backend: Excel imports, photographed
                        stock slips, BOM matching, and document extraction.
                      </p>
                    </section>
                  </div>
                  {fileName && (
                    <section className="panel import-preview">
                      <div className="section-heading">
                        <h3>{fileName}</h3>
                        <span
                          className={
                            "status " + (importErrors.length ? "red" : "green")
                          }
                        >
                          {importErrors.length
                            ? "Needs a correction"
                            : busy
                              ? "Validating…"
                              : serverImport?.status === "committed"
                                ? "Already imported"
                                : `${live ? (serverImport?.rowCount ?? preview.length) : preview.length} valid rows`}
                        </span>
                      </div>
                      {serverImport?.duplicateOfImportId && (
                        <p className="notice" role="note">
                          This file matches an import you already committed.
                          Its orders are already in your workspace.
                        </p>
                      )}
                      {importErrors.length ? (
                        <ul className="error-list" role="alert">
                          {importErrors.slice(0, 10).map((e, i) => (
                            <li key={i}>{e}</li>
                          ))}
                          {importErrors.length > 10 && (
                            <li>
                              …and {importErrors.length - 10} more. Fix these
                              first, then upload the file again.
                            </li>
                          )}
                        </ul>
                      ) : (
                        <>
                          <p>
                            {live
                              ? "Validated by the server. Imported orders remain awaiting analysis until exposure reports are available."
                              : "Validated locally. Imported orders need analysis before their exposure can be verified."}
                          </p>
                          <div className="table-scroll">
                            <table>
                              <thead>
                                <tr>
                                  <th>Order</th>
                                  <th>Product</th>
                                  <th>Destination</th>
                                  <th>Value</th>
                                </tr>
                              </thead>
                              <tbody>
                                {preview.slice(0, 10).map((o) => (
                                  <tr key={o.id}>
                                    <td>{o.id}</td>
                                    <td>{o.product}</td>
                                    <td>{o.destination}</td>
                                    <td>{money(o.value, o.currency)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {(live
                            ? (serverImport?.rowCount ?? preview.length)
                            : preview.length) > 10 && (
                            <p className="fine-print">
                              Showing the first 10 of{" "}
                              {live
                                ? (serverImport?.rowCount ?? preview.length)
                                : preview.length}{" "}
                              rows.
                            </p>
                          )}
                          <Button
                            disabled={
                              busy ||
                              !editable ||
                              !preview.length ||
                              (live && serverImport?.status !== "validated")
                            }
                            onClick={() => void mutate(commitImport)}
                          >
                            {busy
                              ? "Processing…"
                              : serverImport?.status === "committed"
                                ? "Already imported"
                                : `Import ${live ? (serverImport?.rowCount ?? preview.length) : preview.length} orders`}
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
              )}
              {route === "playbook" && (
                <>
                  <PageHeading
                    label="YOUR EXPERIENCE. WRITTEN INTO THE PROCESS."
                    title="Your playbook."
                    description="Set thresholds and trading policies."
                  />
                  <div className="notice">
                    <Settings2 size={18} />
                    {live
                      ? "Rules are saved to your company playbook. Applying them to analysis is not available yet."
                      : "Rules are saved in this browser for the sample demo."}
                  </div>
                  <div className="playbook-grid">
                    <section>
                      <div className="section-heading">
                        <h2>The rules you trade by.</h2>
                        <span className="eyebrow">
                          {rules.filter((r) => r.enabled).length} ACTIVE
                        </span>
                      </div>
                      {rules.map((r) => (
                        <div
                          className={
                            "playbook-rule " +
                            (!r.enabled ? "disabled-rule" : "")
                          }
                          key={r.id}
                        >
                          <div>
                            <span className="eyebrow">{r.category}</span>
                            <p>{r.text}</p>
                          </div>
                          <button
                            className={"toggle " + (r.enabled ? "on" : "")}
                            role="switch"
                            aria-checked={r.enabled}
                            aria-label={`Enable rule: ${r.text}`}
                            disabled={busy || !editable}
                            onClick={() =>
                              live
                                ? void mutate(async () => {
                                    const updated = await api.toggleRule(r);
                                    setRules((v) =>
                                      v.map((x) =>
                                        x.id === r.id ? updated : x,
                                      ),
                                    );
                                  })
                                : setRules((v) =>
                                    v.map((x) =>
                                      x.id === r.id
                                        ? { ...x, enabled: !x.enabled }
                                        : x,
                                    ),
                                  )
                            }
                          >
                            <span />
                          </button>
                          <button
                            className={
                              "icon-btn" +
                              (confirmDelete === r.id ? " confirm-delete" : "")
                            }
                            aria-label={
                              confirmDelete === r.id
                                ? `Confirm delete rule: ${r.text}`
                                : `Delete rule: ${r.text}`
                            }
                            disabled={busy || !editable}
                            onClick={() => {
                              if (confirmDelete !== r.id) {
                                setConfirmDelete(r.id);
                                return;
                              }
                              setConfirmDelete(null);
                              if (live)
                                void mutate(async () => {
                                  await api.deleteRule(r.id);
                                  setRules((v) =>
                                    v.filter((x) => x.id !== r.id),
                                  );
                                  setToast("Rule deleted.");
                                });
                              else {
                                setRules((v) => v.filter((x) => x.id !== r.id));
                                setToast("Rule deleted.");
                              }
                            }}
                          >
                            {confirmDelete === r.id ? (
                              <>
                                <Check size={15} />
                                <span>Delete?</span>
                              </>
                            ) : (
                              <Trash2 size={16} />
                            )}
                          </button>
                        </div>
                      ))}
                      {!rules.length && (
                        <div className="empty">
                          Your playbook is a clean slate. Add your first rule.
                        </div>
                      )}
                    </section>
                    <form
                      className="panel add-rule"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!ruleText.trim()) return;
                        if (live) {
                          void mutate(async () => {
                            const rule = await api.addRule({
                              text: ruleText.trim(),
                              category,
                              enabled: true,
                            });
                            setRules((v) => [...v, rule]);
                            setRuleText("");
                            setToast("Rule saved to your playbook.");
                          });
                          return;
                        }
                        setRules((v) => [
                          ...v,
                          {
                            id: crypto.randomUUID(),
                            text: ruleText.trim(),
                            category,
                            enabled: true,
                          },
                        ]);
                        setRuleText("");
                        setToast("Rule added to your local playbook.");
                      }}
                    >
                      <Plus size={25} />
                      <h3>Add a rule.</h3>
                      <label htmlFor="category">Type of rule</label>
                      <select
                        id="category"
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                      >
                        {["Policy", "Threshold", "Supplier", "Watchlist"].map(
                          (c) => (
                            <option key={c}>{c}</option>
                          ),
                        )}
                      </select>
                      <label htmlFor="rule-text">In your own words</label>
                      <textarea
                        id="rule-text"
                        required
                        maxLength={500}
                        value={ruleText}
                        onChange={(e) => setRuleText(e.target.value)}
                        placeholder="For example: Tell me if an order’s margin falls below 8%."
                      />
                      <Button
                        type="submit"
                        disabled={busy || !editable || !ruleText.trim()}
                      >
                        Add to my playbook
                        <ArrowUpRight size={17} />
                      </Button>
                    </form>
                  </div>
                </>
              )}
              {route === "account" && (
                <AccountSettings
                  account={account}
                  onUpdate={(me) => {
                    setProfile(getProfile());
                    // Profile and company details don't change orders, so update
                    // the account in place instead of reloading the workspace.
                    if (me) setAccount(me);
                  }}
                />
              )}
              {live && route.startsWith("orders/") && !detail && (
                <p role="status">{detailError || "Loading order…"}</p>
              )}
              {!(live && route.startsWith("orders/")) &&
                route !== "" &&
                !nav.some(([p]) => p === route) &&
                route.split("/")[0] !== "map" &&
                route.split("/")[0] !== "regulations" &&
                !detail && (
                  <section className="empty">
                    <h2>We couldn’t find that page.</h2>
                    <Button onClick={() => go("")}>Back to overview</Button>
                  </section>
                )}
            </ErrorBoundary>
          )}
          <footer>
            <span className="footer-brand">
              ExportMate<span>®</span>
            </span>
            <span>Trade, with perspective.</span>
            <span>
              {live
                ? "COMPANY DATA · EXPOSURE ANALYSIS PENDING"
                : "FICTIONAL DEMO DATA · NO LIVE MONITORING"}
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div
          className={"toast" + (toast.error ? " error" : "")}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <CircleAlert size={18} /> : <CheckCheck size={18} />}
          {toast.text}
          <button
            className="icon-btn"
            aria-label="Dismiss notification"
            onClick={() => setToastState(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (
              e.target === e.currentTarget &&
              !(modal === "demo" && demoStep < 6)
            )
              setModal(null);
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
              disabled={modal === "demo" && demoStep < 6}
              onClick={() => setModal(null)}
            >
              <X size={20} />
            </button>
            {modal === "demo" && (
              <>
                <span className="eyebrow">
                  A RULE CHANGES. THE DOTS CONNECT.
                </span>
                <h2 id="modal-title">
                  {demoStep < 6
                    ? "From change to clarity."
                    : "Now you know your next move."}
                </h2>
                <p>
                  A simulated EU wood-documentation change, matched against{" "}
                  {initialOrders.length} sample orders. This resets the sample scenario and demo
                  confirmations. Imported orders are preserved.
                </p>
                <div className="demo-trace">
                  {[
                    [
                      "Relevance",
                      "Matches acacia wood, HS 4412.33, EU destination.",
                    ],
                    [
                      "Order exposure",
                      "PO-2291 and PO-2304 match the affected material.",
                    ],
                    [
                      "Cost impact",
                      "$400 documentation + $800 potential delay per order.",
                    ],
                    [
                      "Action planner",
                      "Draft a request for supplier geolocation records.",
                    ],
                    [
                      "Auditor",
                      "Rejected: alternate supplier claim has no evidence.",
                    ],
                    [
                      "Corrected & verified",
                      "Unsupported claim removed. Clause and order rows linked.",
                    ],
                  ].map(([title, text], i) => (
                    <div
                      key={title}
                      className={demoStep >= i ? "complete" : "pending"}
                    >
                      <span
                        className={"step-marker " + (i === 4 ? "audit" : "")}
                      >
                        {demoStep > i ? (
                          <Check size={16} />
                        ) : demoStep === i ? (
                          <Loader2 size={16} className="spin" />
                        ) : (
                          i + 1
                        )}
                      </span>
                      <div>
                        <b>{title}</b>
                        <p>
                          {demoStep >= i ? text : "Waiting for previous step"}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                {demoStep === 6 && (
                  <>
                    <div className="demo-result">
                      <b>2 orders affected.</b>
                      <span>$2,400 estimated maker exposure.</span>
                    </div>
                    <Button
                      onClick={() => {
                        setModal(null);
                        go("orders/PO-2291");
                      }}
                    >
                      Review your next move
                      <ArrowRight size={17} />
                    </Button>
                  </>
                )}
              </>
            )}
            {modal === "message" && (
              <>
                <span className="eyebrow">YOUR ACTION. YOUR APPROVAL.</span>
                <h2 id="modal-title">
                  A conversation that
                  <br />
                  keeps things moving.
                </h2>
                <div className="message-to">
                  <b>To: {selected.supplier}</b>
                  <span>Zalo · {selected.id}</span>
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
                  Demo only. Confirming records this action locally; no message
                  is sent.
                </div>
                <Button
                  disabled={!message.trim()}
                  onClick={() => {
                    setSent((v) => [...new Set([...v, selected.id])]);
                    setModal(null);
                    setToast(
                      "Demo message confirmed. No external message was sent.",
                    );
                  }}
                >
                  Confirm demo message
                  <Send size={16} />
                </Button>
              </>
            )}
            {modal === "evidence" && (
              <>
                <span className="eyebrow">EVERY CLAIM SHOULD HAVE A HOME.</span>
                <h2 id="modal-title">Follow the evidence.</h2>
                <div className="notice">
                  These are illustrative fixtures. They are not verified legal
                  text or current compliance guidance.
                </div>
                <h3>01 / Sample source clause</h3>
                <blockquote>
                  “Geolocation information must identify the plots of land on
                  which the relevant wood was produced.”
                </blockquote>
                <p className="fine-print">
                  Demo obligation EU-WOOD-001 · illustrative §9. Production must
                  link a versioned official document and exact clause.
                </p>
                <h3>02 / Your order row</h3>
                <div className="evidence-data">
                  <span>orders.csv</span>
                  <b>{selected.id}</b>
                  <span>Material</span>
                  <b>Acacia · HS {selected.hsCode}</b>
                  <span>Supplier</span>
                  <b>{selected.supplier}</b>
                  <span>Destination</span>
                  <b>{selected.destination}</b>
                  <span>Geolocation evidence</span>
                  <b className="danger">Missing in sample supplier record</b>
                </div>
                <h3>03 / Cost assumptions</h3>
                <p>
                  $400 documentation preparation + 4 possible delay days ×
                  $200/day = <b>$1,200 estimated exposure</b>. Seeded planning
                  assumptions, not figures mandated by the sample clause.
                </p>
                <Button
                  onClick={() =>
                    download(
                      "exportmate-" + selected.id + "-evidence.txt",
                      `FICTIONAL DEMO EVIDENCE\nOrder: ${selected.id}\nSupplier: ${selected.supplier}\nHS code: ${selected.hsCode}\nDestination: ${selected.destination}\nSample obligation: EU-WOOD-001\nMissing: plot-level geolocation\nAssumptions: USD 400 documentation + 4 days x USD 200/day = USD 1200.\nNot verified legal text or advice.\n`,
                      "text/plain",
                    )
                  }
                >
                  <Download size={16} />
                  Download evidence summary
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function PageHeading({
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
    /^(orders|map|news|rules|regulations|data|playbook)(\/|$)/.test(path);
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
            <App />
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
