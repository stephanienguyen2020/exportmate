// Fetches RSS/Atom feeds safely. Feed URLs can be user-supplied, so only public HTTPS
// hosts are read. The address check runs when the socket connects (custom DNS lookup),
// not in a separate lookup first, so a host can't pass the check with a public address
// and then be fetched at a private one (DNS rebinding, e.g. the metadata server).
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { pipeline } from "node:stream";
import zlib from "node:zlib";
import { XMLParser } from "fast-xml-parser";

const MAX_BYTES = 3_000_000; // after decompression
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;

// Private, loopback, link-local, shared, documentation, multicast and reserved ranges.
// BlockList also matches IPv4-mapped IPv6 addresses (::ffff:10.0.0.1) against the IPv4 rules.
const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  BLOCKED.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 127], // unspecified and loopback
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
])
  BLOCKED.addSubnet(address, prefix, "ipv6");

// The eight 16-bit words of an IPv6 address (handles "::" and a dotted IPv4 tail).
function ipv6Words(ip) {
  let text = ip.toLowerCase();
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, -dotted[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array(fill).fill("0"), ...right].map((w) => parseInt(w, 16));
}
const ipv4Of = (high, low) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

// IPv6 addresses that carry an IPv4 address are judged by that address: NAT64 (DNS64
// networks answer with these for IPv4-only hosts) and 6to4.
function embeddedIpv4(ip) {
  const w = ipv6Words(ip);
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) return ipv4Of(w[6], w[7]);
  if (w[0] === 0x2002) return ipv4Of(w[1], w[2]);
  return null;
}

/** True for any address a feed must not be fetched from (and for anything that isn't an IP). */
export function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return BLOCKED.check(ip, "ipv4");
  if (!net.isIPv6(ip)) return true;
  const inner = embeddedIpv4(ip);
  return inner ? BLOCKED.check(inner, "ipv4") : BLOCKED.check(ip, "ipv6");
}

const blockedError = () => Object.assign(new Error("Private addresses are not allowed"), { code: "EBLOCKED" });

// dns.lookup with every resolved address checked; used by the socket itself.
export function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length) return callback(Object.assign(new Error("Host not found"), { code: "ENOTFOUND" }));
    if (addresses.some((a) => isBlockedAddress(a.address))) return callback(blockedError());
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/** Parses and checks a feed URL's shape. The address itself is checked at connect time. */
export function checkFeedUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("Feed URL must use https");
  if (url.username || url.password) throw new Error("Credentials in URLs are not allowed");
  // Node connects to IP literals without a lookup, so check them here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedAddress(host)) throw blockedError();
  return url;
}

function request(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        lookup: safeLookup,
        headers: {
          "User-Agent": "ExportMateNewsWatch/1.0 (+https://exportmate.vercel.app)",
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      resolve,
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("Feed timed out")));
    req.on("error", reject);
  });
}

// Reads the body, decompressing it, and stops as soon as it passes MAX_BYTES or timeoutMs.
// pipeline (not pipe) carries a failed or timed-out response into the decompressor, so a feed
// that stalls mid-body ends the read with an error instead of waiting forever or crashing.
export async function readBody(res, timeoutMs = TIMEOUT_MS) {
  const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
  const decoder =
    encoding === "gzip"
      ? zlib.createGunzip()
      : encoding === "deflate"
        ? zlib.createInflate()
        : encoding === "br"
          ? zlib.createBrotliDecompress()
          : null;
  const stream = decoder ? pipeline(res, decoder, () => {}) : res;
  const deadline = setTimeout(() => res.destroy(new Error("Feed timed out")), timeoutMs);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        res.destroy();
        throw new Error("Feed too large");
      }
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(deadline);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const text = (v) => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  return text(v["#text"] ?? v["@_href"] ?? "");
};
const strip = (s) =>
  s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

/** Turns RSS/Atom XML into articles, newest first. */
export function parseFeed(body, { limit = 25 } = {}) {
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

export async function fetchFeed(rawUrl, { limit = 25 } = {}) {
  let url = checkFeedUrl(rawUrl);
  for (let hop = 0; ; hop++) {
    const res = await request(url);
    // Unread bodies are dropped with destroy(): a resumed one left draining has no error
    // listener, so a stall that hits the socket timeout would crash the process.
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.destroy();
      if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects");
      url = checkFeedUrl(new URL(res.headers.location, url).href);
      continue;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.destroy();
      throw new Error(`HTTP ${res.statusCode}`);
    }
    return parseFeed(await readBody(res), { limit });
  }
}
