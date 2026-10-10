// Fetches RSS/Atom feeds safely. Feed URLs can be user-supplied, so block
// non-HTTPS URLs and private/link-local addresses (e.g. the metadata server).
import dns from "node:dns/promises";
import net from "node:net";
import { XMLParser } from "fast-xml-parser";

const MAX_BYTES = 3_000_000;

function privateIp(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function assertSafeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("Feed URL must use https");
  if (url.username || url.password) throw new Error("Credentials in URLs are not allowed");
  const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error("Host not found");
  if (addrs.some((a) => privateIp(a.address))) throw new Error("Private addresses are not allowed");
  return url;
}

const text = (v) => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  return text(v["#text"] ?? v["@_href"] ?? "");
};
const strip = (s) =>
  s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

export async function fetchFeed(rawUrl, { limit = 25 } = {}) {
  let url = await assertSafeUrl(rawUrl);
  let res;
  for (let hop = 0; hop < 4; hop++) {
    res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "ExportMateNewsWatch/1.0 (+https://exportmate.vercel.app)", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    });
    if (res.status < 300 || res.status >= 400) break;
    url = await assertSafeUrl(new URL(res.headers.get("location"), url).href);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new Error("Feed too large");
  const xml = new XMLParser({ ignoreAttributes: false, processEntities: true }).parse(body);
  const raw = xml?.rss?.channel?.item ?? xml?.feed?.entry ?? xml?.["rdf:RDF"]?.item;
  if (!raw) {
    if (xml?.rss?.channel || xml?.feed) return [];
    throw new Error("Not an RSS or Atom feed");
  }
  return (Array.isArray(raw) ? raw : [raw])
    .map((it) => {
      const link = Array.isArray(it.link) ? it.link.find((l) => l["@_rel"] !== "self") ?? it.link[0] : it.link;
      const date = new Date(text(it.pubDate ?? it.published ?? it.updated ?? it["dc:date"]));
      return {
        title: strip(text(it.title)).slice(0, 300),
        url: text(link).trim(),
        publishedAt: isNaN(date) ? null : date.toISOString(),
        snippet: strip(text(it.description ?? it.summary ?? it["content:encoded"] ?? it.content)).slice(0, 600),
        publisher: strip(text(it.source)),
      };
    })
    .filter((a) => a.title && /^https?:\/\//.test(a.url))
    .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""))
    .slice(0, limit);
}
