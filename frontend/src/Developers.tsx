import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Copy,
  Play,
  Search,
} from "lucide-react";
import {
  absoluteApiUrl,
  callMcpTool,
  callPublicEndpoint,
  fetchPublicSpec,
  listMcpTools,
  mcpUrl,
  publicSpecPath,
  type JsonSchema,
  type McpTool,
  type OpenApiOperation,
  type OpenApiSpec,
} from "./api";
import "./developers.css";

// The developer docs (#/developers, #/mcp): an MCP tab and a REST tab. Both are read from the
// server (MCP tools/list, the public OpenAPI spec): tools, endpoints, arguments, examples and
// limits. "Run" calls the real server and shows its real answer, never a made-up example.
export type DevTab = "mcp" | "api";
type Load<T> =
  { kind: "loading" } | { kind: "failed" } | { kind: "ready"; value: T };
type RunResult = { ok: boolean; label: string; output: unknown };

const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

function resolve(
  schema: JsonSchema | undefined,
  spec?: OpenApiSpec,
): JsonSchema {
  const ref = schema?.$ref?.split("/").pop();
  return (ref && spec?.components?.schemas?.[ref]) || schema || {};
}

// An input built from the schema: each property's first example, else its default.
function exampleOf(schema: JsonSchema, spec?: OpenApiSpec) {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(
    resolve(schema, spec).properties || {},
  )) {
    const value = prop.examples?.[0] ?? prop.default;
    if (value !== undefined && value !== "") out[name] = value;
  }
  return out;
}

function useLoad<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    load(abort.signal)
      .then((value) => setState({ kind: "ready", value }))
      .catch(() => {
        if (!abort.signal.aborted) setState({ kind: "failed" });
      });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <figure className="dev-code">
      <figcaption>
        <span>{label}</span>
        <button
          type="button"
          aria-label={`Copy ${label}`}
          onClick={() =>
            navigator.clipboard
              .writeText(text)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              })
              .catch(() => {})
          }
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre>
        <code>{text}</code>
      </pre>
    </figure>
  );
}

function Paragraphs({ text }: { text?: string }) {
  return (
    <>
      {(text || "")
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .map((p) => (
          <p key={p}>{p}</p>
        ))}
    </>
  );
}

function Status({ load, what }: { load: Load<unknown>; what: string }) {
  if (load.kind === "loading")
    return <p className="dev-status">Asking the server for its {what}…</p>;
  return (
    <p className="dev-status">
      <strong>The server didn't answer.</strong> Try again in a minute.
    </p>
  );
}

// An editable JSON input with a Run button and the real output.
function Runner({
  input,
  setInput,
  inputLabel,
  run,
}: {
  input: string;
  setInput: (v: string) => void;
  inputLabel: string;
  run: (parsed: Record<string, unknown>) => Promise<RunResult>;
}) {
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const go = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = input.trim() ? JSON.parse(input) : {};
    } catch {
      setResult({
        ok: false,
        label: "Not valid JSON",
        output: "Fix the input and run it again.",
      });
      return;
    }
    setRunning(true);
    try {
      setResult(await run(parsed));
    } catch (error) {
      setResult({
        ok: false,
        label: "Didn't reach the server",
        output: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="dev-run">
      <div className="dev-panel">
        <div className="dev-panel-top">
          <label htmlFor="dev-input">{inputLabel}</label>
          <button
            type="button"
            className="dev-run-button"
            onClick={go}
            disabled={running}
          >
            <Play size={13} /> {running ? "Running…" : "Run"}
          </button>
        </div>
        <textarea
          id="dev-input"
          spellCheck={false}
          value={input}
          rows={Math.max(4, input.split("\n").length + 1)}
          onChange={(e) => setInput(e.target.value)}
        />
      </div>
      <div className="dev-panel" aria-live="polite">
        <div className="dev-panel-top">
          <span>
            {result ? (
              <span className={result.ok ? "dev-ok" : "dev-bad"}>
                {result.label}
              </span>
            ) : (
              "Output"
            )}
          </span>
        </div>
        <pre className="dev-output">
          <code>
            {result
              ? pretty(result.output)
              : "Run it to see the server's real answer."}
          </code>
        </pre>
      </div>
    </div>
  );
}

const limitChip = (limit?: {
  perCallerPerHour: number;
  totalPerHour: number;
}) =>
  limit && (
    <span className="dev-chip">
      {limit.perCallerPerHour} / hour per caller · {limit.totalPerHour} / hour
      total
    </span>
  );

function McpTab() {
  const url = mcpUrl();
  const tools = useLoad(listMcpTools);
  const clients = [
    {
      id: "claude-code",
      label: "Claude Code",
      text: `claude mcp add --transport http exportmate ${url}`,
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      text: `gemini mcp add --transport http exportmate ${url}`,
    },
    {
      id: "cursor",
      label: "Cursor",
      caption: "~/.cursor/mcp.json",
      text: JSON.stringify({ mcpServers: { exportmate: { url } } }, null, 2),
    },
    {
      id: "claude",
      label: "Claude apps",
      caption: "Settings › Connectors › Add custom connector, then paste",
      text: url,
    },
  ];
  const [client, setClient] = useState(clients[0].id);
  const chosen = clients.find((c) => c.id === client) || clients[0];
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState("");
  const [input, setInput] = useState("");
  const list = tools.kind === "ready" ? tools.value : [];
  const shown = list.filter((t) =>
    (t.name + " " + (t.description || ""))
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const tool: McpTool | undefined =
    list.find((t) => t.name === picked) || list[0];
  useEffect(() => {
    if (tool) setInput(pretty(exampleOf(tool.inputSchema)));
  }, [tool?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <section className="dev-block" aria-labelledby="dev-connect">
        <div className="dev-block-head">
          <h2 id="dev-connect">Connect a client</h2>
          <span className="dev-muted">
            Streamable HTTP · read-only · no sign-in
          </span>
        </div>
        <div className="dev-subtabs" role="tablist" aria-label="MCP clients">
          {clients.map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={c.id === chosen.id}
              className={c.id === chosen.id ? "active" : ""}
              onClick={() => setClient(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <CopyBlock label={chosen.caption || chosen.label} text={chosen.text} />
      </section>

      <section className="dev-block" aria-labelledby="dev-tools">
        <div className="dev-block-head">
          <h2 id="dev-tools">Pick a tool</h2>
          <span className="dev-muted">
            Read live from the server's tools/list
          </span>
        </div>
        {tools.kind !== "ready" ? (
          <Status load={tools} what="tools" />
        ) : (
          <div className="dev-picker">
            <div className="dev-list">
              <label className="dev-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  placeholder="Search tools"
                  aria-label="Search tools"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </label>
              <p className="dev-muted">
                {shown.length} of {list.length} tools
              </p>
              <ul>
                {shown.map((t) => (
                  <li key={t.name}>
                    <button
                      type="button"
                      className={t.name === tool?.name ? "active" : ""}
                      aria-current={t.name === tool?.name}
                      onClick={() => setPicked(t.name)}
                    >
                      {t.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            {tool && (
              <article className="dev-detail">
                <div className="dev-detail-head">
                  <h3>
                    <code>{tool.name}</code>
                  </h3>
                  <div className="dev-chips">
                    {tool.annotations?.readOnlyHint && (
                      <span className="dev-chip">read-only</span>
                    )}
                    {limitChip(tool._meta?.rateLimit)}
                  </div>
                </div>
                <Paragraphs text={tool.description} />
                <Arguments schema={tool.inputSchema} />
                <Runner
                  key={tool.name}
                  input={input}
                  setInput={setInput}
                  inputLabel="JSON input"
                  run={async (args) => {
                    const { ok, output } = await callMcpTool(tool.name, args);
                    return {
                      ok,
                      label: ok ? "Structured output" : "Tool error",
                      output,
                    };
                  }}
                />
              </article>
            )}
          </div>
        )}
      </section>
    </>
  );
}

function Arguments({
  schema,
  spec,
}: {
  schema: JsonSchema;
  spec?: OpenApiSpec;
}) {
  const resolved = resolve(schema, spec);
  const props = Object.entries(resolved.properties || {});
  if (!props.length) return <p className="dev-muted">No arguments.</p>;
  const required = new Set(resolved.required || []);
  return (
    <dl className="dev-args">
      {props.map(([name, prop]) => (
        <div key={name}>
          <dt>
            <code>{name}</code>
            <span>
              {prop.type || "value"}
              {required.has(name) ? ", required" : ""}
            </span>
          </dt>
          <dd>{prop.description}</dd>
        </div>
      ))}
    </dl>
  );
}

type Endpoint = { method: string; path: string; op: OpenApiOperation };

function requestInput(e: Endpoint, spec: OpenApiSpec): Record<string, unknown> {
  const body = e.op.requestBody?.content?.["application/json"]?.schema;
  if (body) return exampleOf(body, spec);
  const out: Record<string, unknown> = {};
  for (const p of e.op.parameters || []) {
    const value = p.schema?.examples?.[0] ?? p.schema?.default;
    if (p.in === "query" && value !== undefined) out[p.name] = value;
  }
  return out;
}

function urlFor(e: Endpoint, input: Record<string, unknown>) {
  const url = new URL(absoluteApiUrl(e.path.replace(/^\/api\/v1/, "")));
  if (!e.op.requestBody)
    for (const [k, v] of Object.entries(input))
      url.searchParams.set(k, String(v));
  return url.href;
}

function curl(e: Endpoint, input: Record<string, unknown>) {
  const url = urlFor(e, input);
  if (!e.op.requestBody) return `curl "${url}"`;
  const body = JSON.stringify(input).replace(/'/g, "'\\''");
  return `curl -X ${e.method} "${url}" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;
}

function ApiTab() {
  const spec = useLoad(fetchPublicSpec);
  const endpoints: Endpoint[] = useMemo(
    () =>
      spec.kind === "ready"
        ? Object.entries(spec.value.paths).flatMap(([path, ops]) =>
            Object.entries(ops).map(([method, op]) => ({
              method: method.toUpperCase(),
              path,
              op,
            })),
          )
        : [],
    [spec],
  );
  const [key, setKey] = useState("");
  const endpoint =
    endpoints.find((e) => `${e.method} ${e.path}` === key) || endpoints[0];
  const [input, setInput] = useState("");
  useEffect(() => {
    if (endpoint && spec.kind === "ready")
      setInput(pretty(requestInput(endpoint, spec.value)));
  }, [endpoint?.method, endpoint?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  let parsed: Record<string, unknown> = {};
  try {
    parsed = input.trim() ? JSON.parse(input) : {};
  } catch {
    /* the Runner says so when it's run */
  }
  if (spec.kind !== "ready")
    return (
      <section className="dev-block">
        <Status load={spec} what="API spec" />
      </section>
    );
  const errors = Object.entries(endpoint?.op.responses || {}).filter(
    ([code]) => code !== "200",
  );
  return (
    <section className="dev-block" aria-labelledby="dev-rest">
      <div className="dev-block-head">
        <h2 id="dev-rest">REST endpoints</h2>
        <span className="dev-muted">
          JSON · no sign-in · read from the OpenAPI spec
        </span>
      </div>
      <label className="dev-select">
        <span>Endpoint</span>
        <select
          value={endpoint ? `${endpoint.method} ${endpoint.path}` : ""}
          onChange={(e) => setKey(e.target.value)}
        >
          {endpoints.map((e) => (
            <option
              key={`${e.method} ${e.path}`}
              value={`${e.method} ${e.path}`}
            >
              {e.method} {e.path}
            </option>
          ))}
        </select>
      </label>
      {endpoint && (
        <article className="dev-detail">
          <div className="dev-chips">
            <span className="dev-chip">no sign-in</span>
            {limitChip(endpoint.op["x-rate-limit"])}
          </div>
          <Paragraphs text={endpoint.op.description || endpoint.op.summary} />
          {endpoint.op.requestBody ? (
            <Arguments
              schema={
                endpoint.op.requestBody.content?.["application/json"]?.schema ||
                {}
              }
              spec={spec.value}
            />
          ) : (
            <dl className="dev-args">
              {(endpoint.op.parameters || []).map((p) => (
                <div key={p.name}>
                  <dt>
                    <code>{p.name}</code>
                    <span>
                      {p.schema?.type || "value"}, {p.in}
                      {p.required ? ", required" : ""}
                    </span>
                  </dt>
                  <dd>{p.description}</dd>
                </div>
              ))}
            </dl>
          )}
          <CopyBlock label="cURL request" text={curl(endpoint, parsed)} />
          <Runner
            key={`${endpoint.method} ${endpoint.path}`}
            input={input}
            setInput={setInput}
            inputLabel={
              endpoint.op.requestBody ? "JSON body" : "Query (as JSON)"
            }
            run={async (args) => {
              const { status, body } = await callPublicEndpoint(
                endpoint.method,
                urlFor(endpoint, args),
                endpoint.op.requestBody ? args : undefined,
              );
              return {
                ok: status < 400,
                label: `${status} response`,
                output: body,
              };
            }}
          />
          {errors.length > 0 && (
            <div className="dev-chips dev-errors">
              {errors.map(([code, r]) => (
                <span key={code} className="dev-chip" title={r.description}>
                  <strong>{code}</strong> {r.description}
                </span>
              ))}
            </div>
          )}
        </article>
      )}
    </section>
  );
}

export default function Developers({ tab }: { tab: DevTab }) {
  useEffect(() => {
    const title = document.title;
    document.title = "API and MCP · ExportMate";
    return () => {
      document.title = title;
    };
  }, []);
  const tabs: { id: DevTab; title: string; sub: string }[] = [
    { id: "mcp", title: "MCP server", sub: "Tools your AI agent can call" },
    { id: "api", title: "REST API", sub: "For customs and business software" },
  ];
  return (
    <div className="dev-page">
      <header className="dev-header">
        <a className="dev-wordmark" href="#/">
          ExportMate<span>®</span>
        </a>
        <a className="dev-back" href="#/">
          <ArrowLeft size={15} /> Back to the site
        </a>
      </header>
      <main className="dev-main">
        <div className="dev-hero">
          <div>
            <span className="dev-kicker">DEVELOPERS / API · MCP</span>
            <h1>
              Connect ExportMate to
              <br />
              <strong>your agent or software.</strong>
            </h1>
            <p className="dev-lede">
              Search the official tariff lines, get the same HS code suggestions
              the app makes, and read how accurate they measured on{" "}
              <a href="#/?section=accuracy">real customs rulings</a>. Read-only,
              no sign-in. Suggestions are AI assessments, not rulings.
            </p>
          </div>
          <a
            className="dev-spec"
            href={absoluteApiUrl(publicSpecPath)}
            target="_blank"
            rel="noreferrer"
          >
            OpenAPI 3.1 spec <ArrowUpRight size={14} />
          </a>
        </div>
        <div className="dev-tabs" role="tablist" aria-label="Ways to connect">
          {tabs.map((t) => (
            <a
              key={t.id}
              role="tab"
              aria-selected={t.id === tab}
              className={t.id === tab ? "active" : ""}
              href={`#/developers?tab=${t.id}`}
            >
              <strong>{t.title}</strong>
              <span>{t.sub}</span>
            </a>
          ))}
        </div>
        {tab === "mcp" ? <McpTab /> : <ApiTab />}
        <p className="dev-foot">
          Not a ruling. Confirm a code with customs or a licensed broker before
          you ship. Company tools (orders, reports, news) come next, with access
          tokens you create in your workspace.
        </p>
      </main>
    </div>
  );
}
