import React, { Fragment, lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bell,
  CheckCheck,
  CircleAlert,
  CircleHelp,
  ClipboardList,
  Globe2,
  LogOut,
  Map as MapIcon,
  Menu,
  Package,
  ShieldCheck,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { AccountSettings } from "../Account";
import { placeCode, routeStops } from "../account-store";
import ErrorBoundary from "../ErrorBoundary";
import WorkspaceSearch from "../Search";
import Tour, { tourDone } from "../Tour";
import NewsWatchPage from "../../ai/news/NewsWatch";
import DataRoom from "./DataRoom";
import DemoDialogs, { type DemoDialog } from "./DemoDialogs";
import { CompanyOrder, SampleOrder } from "./OrderDetail";
import { OrderStatus } from "./OrderTable";
import Orders, { type OrderFilter } from "./Orders";
import Overview from "./Overview";
import PlaybookPage from "./PlaybookPage";
import RuleWatchPage from "./RuleWatchPage";
import { useWorkspace, type Workspace as WorkspaceData } from "./store";
import {
  Button,
  Loading,
  analysedAgain,
  go,
  initialsOf,
  type Notify,
} from "./ui";

const RegulationsPage = lazy(() => import("../Regulations"));
const CompanySettings = lazy(() => import("../CompanySettings"));
const TradeMapPage = lazy(() => import("../TradeMap"));
const ReportsPage = lazy(() => import("../Reports"));
const KnowledgeBasePage = lazy(() => import("../KnowledgeBase"));

// The pages of the "Rules & news" tab. Each keeps its own route, so deep links still work.
const ruleTabs: [string, string][] = [
  ["news", "News watch"],
  ["rules", "Rule watch"],
  ["regulations", "Regulations"],
  ["playbook", "Playbook"],
  ["knowledge", "Knowledge base"],
];
// Sidebar order. Each page is a route below; "Rules & news" opens the first of its tabs.
const nav: [path: string, label: string, icon: typeof Globe2][] = [
  ["", "Overview", Globe2],
  ["orders", "Orders", Package],
  ["map", "Trade map", MapIcon],
  ["news", "Rules & news", ShieldCheck],
  ["reports", "Reports", ClipboardList],
  ["data", "Data room", Upload],
  ["account", "Account", UserRound],
];
// Every page a search or a typed route can reach.
const pages: [string, string][] = [
  ...nav.filter(([p]) => p !== "news").map(([p, l]): [string, string] => [p, l]),
  ...ruleTabs,
];
const ruleTabOf = (section: string) => ruleTabs.find(([p]) => p === section);
/** The sidebar item a section belongs to. */
const navSection = (section: string) => (ruleTabOf(section) ? "news" : section);

// What every page can use from the shell.
type PageContext = {
  ws: WorkspaceData;
  // The rest of the route after the section, e.g. an order ID (still encoded).
  sub: string;
  route: string;
  buyer: boolean;
  notify: Notify;
  orderView: OrderFilter;
  setOrderView: (view: OrderFilter) => void;
  showOrders: (filter: string) => void;
  startDemo: () => void;
  openDialog: (dialog: DemoDialog) => void;
};
type Page = (ctx: PageContext) => React.ReactNode;

// Sections that take no sub-path; `#/workspace/news/x` is not a page.
const exact = (page: Page): Page => (ctx) => (ctx.sub ? null : page(ctx));

const routes: Record<string, Page> = {
  "": exact(({ ws, buyer, startDemo, showOrders }) => (
    <Overview
      ws={ws}
      buyer={buyer}
      startDemo={startDemo}
      showOrders={showOrders}
    />
  )),
  orders: ({ ws, sub, buyer, notify, orderView, setOrderView, openDialog }) => {
    if (!sub)
      return (
        <Orders
          ws={ws}
          buyer={buyer}
          view={orderView}
          onView={setOrderView}
          notify={notify}
        />
      );
    if (ws.live)
      return (
        <CompanyOrder
          key={sub}
          id={decodeURIComponent(sub)}
          ws={ws}
          notify={notify}
        />
      );
    const order = ws.orders.find((o) => encodeURIComponent(o.id) === sub);
    return order ? (
      <SampleOrder
        order={order}
        ws={ws}
        buyer={buyer}
        notify={notify}
        onMessage={(o) => openDialog({ kind: "message", order: o })}
        onEvidence={(o) => openDialog({ kind: "evidence", order: o })}
      />
    ) : null;
  },
  map: ({ ws, sub, route, notify }) => (
    <Suspense fallback={<Loading icon>Loading the map…</Loading>}>
      <TradeMapPage
        key={route}
        live={ws.live}
        editable={ws.editable}
        focus={sub}
        toneOf={ws.tone}
        renderStatus={(o) => <OrderStatus order={o} ws={ws} />}
        onNavigate={go}
        signature={`${ws.profile.name} · ${ws.profile.company || "Your company"}`}
        companyOrigin={ws.profile.origin}
        onOrdersAnalysed={(orderIds) => {
          if (!orderIds.length) return;
          notify(`Supplier saved.${analysedAgain(orderIds)}`);
          // If this fails, the order lists catch up on the next load.
          ws.refreshOrders().catch(() => undefined);
        }}
      />
    </Suspense>
  ),
  news: exact(({ ws }) => (
    <NewsWatchPage
      live={ws.live}
      editable={ws.editable}
      sourcesLocked={
        !ws.live
          ? "Sign in to a company workspace to add or switch off sources."
          : ws.editable
            ? undefined
            : "Only company owners and editors can change sources."
      }
      scanLocked={
        !ws.live
          ? "Sign in to a company workspace to run a scan."
          : ws.editable
            ? undefined
            : "Only company owners and editors can run a scan."
      }
    />
  )),
  rules: exact(({ ws, startDemo, showOrders }) => (
    <RuleWatchPage ws={ws} startDemo={startDemo} showOrders={showOrders} />
  )),
  regulations: ({ ws, sub, route }) => (
    <Suspense fallback={<Loading>Loading regulations…</Loading>}>
      <RegulationsPage
        key={route}
        live={ws.live}
        editable={ws.editable}
        owner={ws.account?.role === "owner"}
        path={sub ? "/" + sub : ""}
      />
    </Suspense>
  ),
  reports: ({ ws, sub, notify }) => (
    <Suspense fallback={<Loading>Loading reports…</Loading>}>
      <ReportsPage
        key={sub.split("/")[0]}
        live={ws.live}
        editable={ws.editable}
        path={sub ? "/" + sub : ""}
        notify={notify}
      />
    </Suspense>
  ),
  knowledge: exact(({ ws, notify }) => (
    <Suspense fallback={<Loading>Loading knowledge base…</Loading>}>
      <KnowledgeBasePage live={ws.live} editable={ws.editable} notify={notify} />
    </Suspense>
  )),
  data: exact(({ ws, notify }) => <DataRoom ws={ws} notify={notify} />),
  playbook: exact(({ ws, notify }) => <PlaybookPage ws={ws} notify={notify} />),
  account: exact(({ ws, notify }) => (
    <>
      <AccountSettings
        account={ws.account}
        onUpdate={(me) => {
          ws.reloadProfile();
          // Profile and company details don't change orders, so update
          // the account in place instead of reloading the workspace.
          if (me) ws.setAccount(me);
        }}
      />
      {ws.live && ws.account && (
        <Suspense fallback={null}>
          <CompanySettings role={ws.account.role} notify={notify} />
        </Suspense>
      )}
    </>
  )),
};

const currentRoute = () =>
  location.hash.replace(/^#\/?/, "").replace(/^workspace\/?/, "");

export default function Workspace() {
  const [toast, setToastState] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const notify: Notify = (text, error = false) =>
    setToastState(text ? { text, error } : null);
  const ws = useWorkspace(notify);
  const { live, profile, exposed } = ws;
  const [route, setRoute] = useState(currentRoute);
  const [section, ...rest] = route.split("/");
  const sub = rest.join("/");
  const [buyer, setBuyer] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [touring, setTouring] = useState(false);
  const [dialog, setDialog] = useState<DemoDialog | null>(null);
  const [orderView, setOrderView] = useState<OrderFilter>({
    filter: "All orders",
    search: "",
  });
  const showOrders = (filter: string) => {
    setOrderView((v) => ({ ...v, filter }));
    go("orders");
  };
  const startDemo = () => {
    if (live) {
      // Signed-in companies analyse their own orders from the Orders page.
      go("orders");
      return;
    }
    ws.resetSampleChange();
    setDialog({ kind: "demo" });
  };
  // First visit: the tour opens once the workspace has loaded.
  const tourOffered = useRef(false);
  useEffect(() => {
    if (tourOffered.current || (live && (ws.loading || ws.loadError))) return;
    tourOffered.current = true;
    if (!tourDone()) setTouring(true);
  }, [live, ws.loading, ws.loadError]);
  useEffect(() => {
    const fn = () => {
      setRoute(currentRoute());
      setMobile(false);
    };
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  // On a phone the Rules & news tab bar scrolls sideways: keep the current tab in view.
  useEffect(() => {
    document
      .querySelector(".section-tabs a.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [route]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToastState(null), toast.error ? 9000 : 4500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const initials = initialsOf(profile.name) || "EM";
  const page = (Object.hasOwn(routes, section) ? routes[section] : null)?.({
    ws,
    sub,
    route,
    buyer,
    notify,
    orderView,
    setOrderView,
    showOrders,
    startDemo,
    openDialog: setDialog,
  });
  const onOrder = section === "orders" && sub !== "";
  const ruleTab = ruleTabOf(section);
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
          <span className="company-mark">
            {initialsOf(profile.company) || "EM"}
          </span>
          <div>
            <strong>{profile.company || "Your company"}</strong>
            <small>{profile.role} workspace</small>
          </div>
        </div>
        <div className="nav-label">YOUR WORKSPACE</div>
        <nav>
          {nav.map(([path, label, Icon]) => (
            <a
              className={(navSection(section) === path ? "active " : "") + "nav-item"}
              href={"#/workspace/" + path}
              key={path}
              data-tour={"nav-" + path}
              onClick={() =>
                path === "orders" &&
                setOrderView((v) => ({ ...v, filter: "All orders" }))
              }
            >
              <Icon size={18} />
              {label}
              {path === "orders" && (
                <span className="nav-count">{ws.orders.length}</span>
              )}
              {path === "news" && !live && exposed.length > 0 && (
                <span className="nav-dot" />
              )}
            </a>
          ))}
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
                    ? ws.account?.role
                      ? ws.account.role[0].toUpperCase() +
                        ws.account.role.slice(1)
                      : "Member"
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
              {onOrder && page
                ? "Order impact"
                : ruleTab
                  ? `Rules & news / ${ruleTab[1]}`
                  : nav.find(([p]) => p === section)?.[1] || "Overview"}
            </strong>
          </div>
          <div className="top-actions">
            <WorkspaceSearch
              live={live}
              pages={pages}
              orders={ws.orders}
              rules={ws.rules}
              onNavigate={(path) => {
                setMobile(false);
                go(path);
              }}
            />
            <span className="demo-badge">
              {live ? "CONNECTED WORKSPACE" : "DEMO WORKSPACE"}
            </span>
            {!live && (
              <div
                className="perspective"
                data-tour="perspective"
                role="group"
                aria-label="See the demo as the maker or the buyer"
              >
                <button
                  aria-pressed={!buyer}
                  title={`${profile.name}, the Vietnamese maker: documentation and delay costs in USD`}
                  onClick={() => setBuyer(false)}
                >
                  Maker
                </button>
                <button
                  aria-pressed={buyer}
                  title="James Tan, a Singapore buyer of the same orders: margin exposure in SGD"
                  onClick={() => setBuyer(true)}
                >
                  Buyer
                </button>
              </div>
            )}
            <button
              className="icon-btn"
              data-tour="help"
              aria-label="Show the workspace tour"
              title="Show the workspace tour"
              onClick={() => {
                setMobile(false);
                setTouring(true);
              }}
            >
              <CircleHelp size={18} />
            </button>
            <button
              className="notification icon-btn"
              aria-label="View alerts"
              onClick={() => showOrders(ws.actionFilter)}
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
                className={navSection(section) === p ? "active" : ""}
                aria-current={navSection(section) === p ? "page" : undefined}
                onClick={() => {
                  setMobile(false);
                  if (p === "orders")
                    setOrderView((v) => ({ ...v, filter: "All orders" }));
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
          {live && ws.loading ? (
            <Loading icon>Loading your workspace…</Loading>
          ) : live && ws.loadError ? (
            <section className="panel" role="alert">
              <h2>Couldn’t load your workspace.</h2>
              <p>{ws.loadError}</p>
              <Button onClick={() => void ws.refresh()}>Try again</Button>
              <a className="text-link" href="#/login">
                Sign in again
              </a>
            </section>
          ) : (
            <ErrorBoundary resetKey={route}>
              {ruleTab && (
                <nav className="section-tabs" aria-label="Rules & news">
                  {ruleTabs.map(([p, l]) => (
                    <a
                      key={p}
                      href={"#/workspace/" + p}
                      className={ruleTab[0] === p ? "active" : ""}
                      aria-current={ruleTab[0] === p ? "page" : undefined}
                    >
                      {l}
                      {p === "rules" && !live && exposed.length > 0 && (
                        <span className="nav-dot" />
                      )}
                    </a>
                  ))}
                </nav>
              )}
              {page ?? (
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
                ? "COMPANY DATA · ANALYSED AGAINST YOUR MARKET CHECKLISTS"
                : "FICTIONAL DEMO DATA · NO LIVE MONITORING"}
            </span>
          </footer>
        </main>
      </div>
      {touring && <Tour live={live} onClose={() => setTouring(false)} />}
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
      {dialog && (
        <DemoDialogs
          dialog={dialog}
          ws={ws}
          buyer={buyer}
          notify={notify}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
