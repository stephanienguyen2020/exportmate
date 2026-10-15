import { useEffect, useRef, useState } from "react";
import {
  initialOrders,
  initialRules,
  makerCost,
  money,
  readSaved,
  sampleCosts,
  save,
  withSampleRisk,
  type Order,
  type Rule,
} from "../data";
import { getProfile, isApiSession, navigate } from "../account-store";
import {
  api,
  asOrder,
  cacheAccount,
  ApiError,
  type Account,
  type AnalysisRun,
  type Overview,
  type OrderChange,
  type OrderStatusOption,
  type OrderUpdated,
  type RuleFields,
} from "../api";
import { errorMessage } from "../auth";
import { MAX_UPLOAD_MB, validateOrderCsv } from "../order-csv";
import type { Notify } from "./ui";

// The workspace has two kinds of session: the browser-only demo keeps its
// orders and rules in localStorage, a signed-in company reads and writes them
// through the backend. This module is the only place that tells them apart;
// views read `useWorkspace()` and branch on `live` only for wording and for
// features the demo doesn't have.

export type RuleInput = Pick<Rule, "text" | "category"> & {
  when: Rule["when"];
  then: Rule["then"];
};
type RuleChecks = Parameters<typeof api.updateRule>[1];
// An orders CSV checked before import: by the backend, or in the browser.
export type CheckedImport = {
  id: string | null;
  status: "validated" | "invalid" | "committed";
  rowCount: number;
  duplicateOfImportId: string | null;
  preview: Order[];
  errors: string[];
};
type Source = {
  addRule(input: RuleInput): Promise<Rule>;
  toggleRule(rule: Rule): Promise<Rule>;
  updateRule(id: string, change: RuleChecks): Promise<Rule>;
  deleteRule(id: string): Promise<void>;
  checkImport(file: File, existingIds: Set<string>): Promise<CheckedImport>;
  // The demo returns the orders to add; the backend saves them itself and analyses them
  // (`run`, null when that analysis failed).
  commitImport(
    checked: CheckedImport,
  ): Promise<{ created: number; added: Order[] | null; run: AnalysisRun | null }>;
  // The order as changed: the backend saves it and analyses it again (`updated`); the demo
  // checks it against the sample rule change.
  updateOrder(
    order: Order,
    change: OrderChange,
  ): Promise<{ order: Order; updated: OrderUpdated | null }>;
  deleteOrder(id: string): Promise<void>;
};

const apiSource: Source = {
  addRule: (input) => api.addRule({ ...input, enabled: true }),
  toggleRule: (rule) => api.toggleRule(rule),
  updateRule: (id, change) => api.updateRule(id, change),
  deleteRule: async (id) => {
    await api.deleteRule(id);
  },
  async checkImport(file) {
    const uploaded = await api.upload(file);
    const result = await api.import(uploaded.id);
    return {
      id: result.id,
      status: result.status,
      rowCount: result.rowCount,
      duplicateOfImportId: result.duplicateOfImportId,
      errors: result.errors.map(
        (e) =>
          `${e.row ? `Row ${e.row}: ` : ""}${e.field ? `${e.field}: ` : ""}${e.message}`,
      ),
      preview: result.preview.map((row) =>
        asOrder({ ...row, status: "awaiting_analysis" }),
      ),
    };
  },
  async commitImport(checked) {
    const result = await api.commit(checked.id!);
    return { created: result.ordersCreated, added: null, run: result.run };
  },
  async updateOrder(order, change) {
    const updated = await api.updateOrder(order.id, change);
    return { order: asOrder(updated.detail.order), updated };
  },
  deleteOrder: async (id) => {
    await api.deleteOrder(id);
  },
};

const demoSource: Source = {
  addRule: async ({ text, category }) => ({
    id: crypto.randomUUID(),
    text,
    category,
    enabled: true,
  }),
  toggleRule: async (rule) => ({ ...rule, enabled: !rule.enabled }),
  updateRule: async () => {
    throw new Error("Sign in to a company workspace to check rules.");
  },
  deleteRule: async () => undefined,
  async checkImport(file, existingIds) {
    const { default: Papa } = await import("papaparse");
    return new Promise((resolve) =>
      Papa.parse<Record<string, string | undefined>>(file, {
        header: true,
        skipEmptyLines: "greedy",
        transformHeader: (h) => h.trim(),
        complete: (r) => {
          const result = validateOrderCsv(r.meta.fields, r.data, existingIds);
          const errors = [
            ...r.errors.map((e) => `CSV: ${e.message}`),
            ...result.errors,
          ];
          const preview = errors.length ? [] : result.orders;
          resolve({
            id: null,
            status: errors.length ? "invalid" : "validated",
            rowCount: preview.length,
            duplicateOfImportId: null,
            preview,
            errors,
          });
        },
        error: (e) =>
          resolve({
            id: null,
            status: "invalid",
            rowCount: 0,
            duplicateOfImportId: null,
            preview: [],
            errors: [e.message],
          }),
      }),
    );
  },
  // Every imported order is checked against the sample rule change.
  commitImport: async (checked) => ({
    created: checked.preview.length,
    added: checked.preview.map(withSampleRisk),
    run: null,
  }),
  updateOrder: async (order, change) => ({
    order: withSampleRisk({ ...order, ...change }),
    updated: null,
  }),
  deleteOrder: async () => undefined,
};

// Risk is worked out again on load, so orders saved by older versions are checked too.
const savedDemoOrders = () =>
  readSaved(
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
  ).map(withSampleRisk);
const savedDemoRules = () =>
  readSaved(
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
  );

export type Workspace = ReturnType<typeof useWorkspace>;

export function useWorkspace(notify: Notify) {
  const live = isApiSession();
  const source = live ? apiSource : demoSource;
  const [account, setAccount] = useState<Account | null>(null);
  const [profile, setProfile] = useState(getProfile);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [orders, setOrders] = useState<Order[]>(() =>
    live ? [] : savedDemoOrders(),
  );
  const [rules, setRules] = useState<Rule[]>(() =>
    live ? [] : savedDemoRules(),
  );
  // Demo supplier messages confirmed (by order ID).
  const [sent, setSent] = useState<string[]>(() =>
    readSaved(
      "em-sent",
      [],
      (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
    ),
  );
  const [ruleFields, setRuleFields] = useState<RuleFields | null>(null);
  // Signed in: each status's label, colour and whether it may be set by hand, from the database.
  const [statusOptions, setStatusOptions] = useState<OrderStatusOption[]>([]);
  // The analysis the last import ran, shown on the Orders page.
  const [importRun, setImportRun] = useState<AnalysisRun | null>(null);
  const [loading, setLoading] = useState(live);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const mutationRef = useRef(false);
  const workspaceLoad = useRef<AbortController | null>(null);
  const editable =
    !live || account?.role === "owner" || account?.role === "editor";

  async function refresh() {
    if (!live) return;
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
      const [nextOrders, nextRules, nextOverview, nextStatuses] =
        await Promise.all([
          api.orders(signal),
          api.rules(signal),
          api.overview(signal),
          // Without them the workspace still works, with the built-in labels.
          api.orderStatuses(signal).catch(() => []),
        ]);
      if (signal.aborted) return;
      setOrders(nextOrders);
      setRules(nextRules);
      setOverview(nextOverview);
      setStatusOptions(nextStatuses);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError && error.code === "onboarding_required")
        navigate("onboarding");
      setLoadError(errorMessage(error));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }
  // After an analysis: statuses and counts change, but the page stays as it is.
  async function refreshOrders() {
    const [nextOrders, nextOverview] = await Promise.all([
      api.orders(),
      api.overview(),
    ]);
    setOrders(nextOrders);
    setOverview(nextOverview);
  }
  // One change at a time; a failure is shown as an error toast.
  async function mutate(action: () => Promise<void>) {
    if (mutationRef.current) return;
    mutationRef.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      mutationRef.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (live) void refresh();
    return () => workspaceLoad.current?.abort();
  }, [live]);
  useEffect(() => {
    if (!live) save("em-orders", orders);
  }, [orders, live]);
  useEffect(() => {
    if (!live) save("em-rules", rules);
  }, [rules, live]);
  useEffect(() => save("em-sent", sent), [sent]);

  const replaceRule = (rule: Rule) =>
    setRules((v) => v.map((x) => (x.id === rule.id ? rule : x)));
  // After one order changed or went: the list is already up to date, the counts and value at
  // risk come from the backend. If that read fails they catch up on the next load.
  const refreshOverview = () =>
    live
      ? api.overview().then(setOverview, () => undefined)
      : Promise.resolve();

  // The demo checks every order against the sample rule change, so none waits for analysis.
  const isClear = (o: Order) => (live ? o.status === "clear" : !o.risk);
  const isPending = (o: Order) => live && o.status === "awaiting_analysis";
  const statusOption = (code?: string) =>
    live ? statusOptions.find((s) => s.code === code) : undefined;
  return {
    live,
    editable,
    account,
    setAccount,
    profile,
    reloadProfile: () => setProfile(getProfile()),
    overview,
    orders,
    rules,
    sent,
    ruleFields,
    loading,
    loadError,
    busy,
    mutate,
    refresh,
    refreshOrders,
    isClear,
    isPending,
    statusOptions,
    statusOption,
    importRun,
    // The filter that lists exposed orders, named as the database names it when signed in.
    actionFilter: statusOption("exposed")?.label || "Action needed",
    exposed: orders.filter((o) => o.risk),
    tone: (o: Order): "red" | "amber" | "green" =>
      o.risk ? "red" : isClear(o) ? "green" : "amber",
    // Without the fields, rules can still be written in words; the builder just stays hidden.
    loadRuleFields(signal: AbortSignal) {
      if (!live || ruleFields) return;
      api
        .ruleFields(signal)
        .then((fields) => !signal.aborted && setRuleFields(fields))
        .catch(() => undefined);
    },
    async addRule(input: RuleInput) {
      const rule = await source.addRule(input);
      setRules((v) => [...v, rule]);
      return rule;
    },
    async toggleRule(rule: Rule) {
      replaceRule(await source.toggleRule(rule));
    },
    async updateRule(id: string, change: RuleChecks) {
      const rule = await source.updateRule(id, change);
      replaceRule(rule);
      return rule;
    },
    async deleteRule(id: string) {
      await source.deleteRule(id);
      setRules((v) => v.filter((x) => x.id !== id));
    },
    checkImport(file: File): Promise<CheckedImport> {
      if (!file.name.toLowerCase().endsWith(".csv"))
        return Promise.resolve(
          rejected(
            "Please choose a CSV file. For an Excel sheet, use File › Save as › CSV first.",
          ),
        );
      if (file.size > MAX_UPLOAD_MB * 1024 * 1024)
        return Promise.resolve(
          rejected(`File must be smaller than ${MAX_UPLOAD_MB} MB.`),
        );
      return source.checkImport(file, new Set(orders.map((o) => o.id)));
    },
    // In the demo, `added` are the new orders with their sample check.
    async commitImport(checked: CheckedImport) {
      const result = await source.commitImport(checked);
      const { added } = result;
      setImportRun(result.run);
      if (added) setOrders((v) => [...v, ...added]);
      else await refresh();
      return result;
    },
    // Owners and editors (and the demo) change an order's details; signed in, the result
    // carries the order's page after its new analysis.
    async saveOrder(order: Order, change: OrderChange) {
      const result = await source.updateOrder(order, change);
      setOrders((v) => v.map((o) => (o.id === order.id ? result.order : o)));
      void refreshOverview();
      return result.updated;
    },
    async removeOrder(id: string) {
      await source.deleteOrder(id);
      setOrders((v) => v.filter((o) => o.id !== id));
      setSent((v) => v.filter((x) => x !== id));
      void refreshOverview();
    },
    markSent(id: string) {
      setSent((v) => [...new Set([...v, id])]);
    },
    // Demo walkthrough: clear every order, then land the sample rule change.
    resetSampleChange() {
      setOrders((v) => v.map((o) => ({ ...o, risk: false })));
      setSent([]);
    },
    // Every order, seeded or imported, is checked against it.
    applySampleChange() {
      setOrders((v) =>
        [
          ...initialOrders,
          ...v.filter((o) => !initialOrders.some((seed) => seed.id === o.id)),
        ].map(withSampleRisk),
      );
      setSent([]);
    },
  };
}

const rejected = (error: string): CheckedImport => ({
  id: null,
  status: "invalid",
  rowCount: 0,
  duplicateOfImportId: null,
  preview: [],
  errors: [error],
});

// Signed-in companies see the full value of affected orders per currency; the
// demo estimates a cost per affected order from the maker's or buyer's view.
export function valueAtRisk(ws: Workspace, buyer: boolean) {
  const currency = buyer
    ? sampleCosts.buyer.currency
    : sampleCosts.maker.currency;
  const display = ws.live
    ? Object.entries(ws.overview?.valueAtRiskByCurrency || {})
        .map(([code, minor]) => money(minor / 100, code))
        .join(" + ") || "—"
    : money(
        ws.exposed.length * (buyer ? sampleCosts.buyer.margin : makerCost),
        currency,
      );
  // "$2,400" needs "USD" after it; "SGD 14,800" already names its currency.
  return { display, currency: display.includes(currency) ? "" : currency };
}
