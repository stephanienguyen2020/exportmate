import { useEffect, useState } from "react";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { listMcpTools, mcpUrl, type McpTool } from "./api";
import "./mcp-docs.css";

// The public MCP docs (#/mcp). The tool list is read from the server itself (tools/list), so
// this page can't drift from what an agent sees. Fuller notes: backend/docs/MCP.md.
type Tools =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; tools: McpTool[] };

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <figure className="mcp-code">
      <figcaption>
        <span>{label}</span>
        <button
          type="button"
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

export default function McpDocs() {
  const url = mcpUrl();
  const [tools, setTools] = useState<Tools>({ kind: "loading" });
  useEffect(() => {
    document.title = "MCP server · ExportMate";
    const abort = new AbortController();
    listMcpTools(abort.signal)
      .then((list) => setTools({ kind: "ready", tools: list }))
      .catch(() => {
        if (!abort.signal.aborted) setTools({ kind: "failed" });
      });
    return () => abort.abort();
  }, []);
  const json = JSON.stringify(
    { mcpServers: { exportmate: { type: "http", url } } },
    null,
    2,
  );
  return (
    <div className="mcp-page">
      <header className="mcp-header">
        <a className="mcp-wordmark" href="#/">
          ExportMate<span>®</span>
        </a>
        <a className="mcp-back" href="#/">
          <ArrowLeft size={15} /> Back to the site
        </a>
      </header>
      <main className="mcp-main">
        <span className="mcp-kicker">DEVELOPERS / MCP SERVER</span>
        <h1>
          HS codes for
          <br />
          <strong>your AI agent.</strong>
        </h1>
        <p className="mcp-lede">
          ExportMate's Model Context Protocol server gives Claude, Cursor or
          your own agent the same HS code suggestions the app makes, the
          official tariff lines behind them, and how accurate they measured.
          Read-only, no sign-in.
        </p>

        <section aria-labelledby="mcp-connect">
          <h2 id="mcp-connect">Connect</h2>
          <CopyBlock label="Server URL (Streamable HTTP)" text={url} />
          <CopyBlock
            label="Claude Code"
            text={`claude mcp add --transport http exportmate ${url}`}
          />
          <CopyBlock label="A project's .mcp.json" text={json} />
        </section>

        <section
          aria-labelledby="mcp-tools"
          aria-busy={tools.kind === "loading"}
        >
          <h2 id="mcp-tools">Tools</h2>
          <p className="mcp-note">Read live from the server.</p>
          {tools.kind === "loading" && (
            <p className="mcp-status">Asking the server for its tools…</p>
          )}
          {tools.kind === "failed" && (
            <p className="mcp-status">
              <strong>The server didn't answer.</strong> Try again in a minute.
            </p>
          )}
          {tools.kind === "ready" && (
            <div className="mcp-tools">
              {tools.tools.map((tool) => {
                const props = tool.inputSchema.properties || {};
                const required = new Set(tool.inputSchema.required || []);
                return (
                  <article key={tool.name} className="mcp-tool">
                    <h3>
                      <code>{tool.name}</code>
                      {tool.annotations?.readOnlyHint && <span>read-only</span>}
                    </h3>
                    {(tool.description || "")
                      .split(/\n\s*\n/)
                      .map((para) => para.replace(/\s+/g, " ").trim())
                      .filter(Boolean)
                      .map((para) => (
                        <p key={para}>{para}</p>
                      ))}
                    {Object.keys(props).length > 0 && (
                      <dl>
                        {Object.entries(props).map(([name, schema]) => (
                          <div key={name}>
                            <dt>
                              <code>{name}</code>
                              {required.has(name) ? " (required)" : ""}
                            </dt>
                            <dd>
                              {schema.type || "value"}
                              {schema.default !== undefined &&
                                schema.default !== "" &&
                                `, default ${JSON.stringify(schema.default)}`}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section aria-labelledby="mcp-limits">
          <h2 id="mcp-limits">Limits and trust</h2>
          <ul className="mcp-list">
            <li>
              Each <code>suggest_hs_codes</code> call is an AI call, so it's
              limited per caller and in total per hour. Past a limit the tool
              says when to try again.
            </li>
            <li>
              Suggestions are AI assessments, not customs rulings. Show the
              reason and the official wording with each code, and confirm a code
              with customs or a licensed broker before you ship.
            </li>
            <li>
              <code>get_hs_benchmark</code> returns the latest measured accuracy
              on real customs rulings, the same figures as{" "}
              <a href="#/?section=accuracy">How accurate is it?</a>
            </li>
            <li>
              Company tools (orders, reports, news) come next, with access
              tokens you create in your workspace.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
