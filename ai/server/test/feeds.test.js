import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import zlib from "node:zlib";
import { checkFeedUrl, isBlockedAddress, parseFeed, readBody, safeLookup } from "../feeds.js";

test("blocks private, loopback, metadata and translated addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "not-an-ip",
  ])
    assert.ok(isBlockedAddress(ip), ip);
  // NAT64 and 6to4 addresses are judged by the IPv4 address inside them.
  for (const ip of ["8.8.8.8", "151.101.1.67", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::6f41:fa0f", "64:ff9b::111.65.250.15", "2002:0808:0808::1"])
    assert.ok(!isBlockedAddress(ip), ip);
});

test("feed URLs must be HTTPS without credentials or private IP literals", () => {
  assert.equal(checkFeedUrl("https://example.com/feed.xml").hostname, "example.com");
  assert.throws(() => checkFeedUrl("http://example.com/feed"), /https/);
  assert.throws(() => checkFeedUrl("https://user:pw@example.com/feed"), /Credentials/);
  assert.throws(() => checkFeedUrl("https://169.254.169.254/latest"), /Private/);
  assert.throws(() => checkFeedUrl("https://[::1]/feed"), /Private/);
  assert.throws(() => checkFeedUrl("not a url"), /valid URL/);
});

test("the connect-time lookup refuses hosts that resolve to private addresses", async () => {
  const lookup = (host, options) =>
    new Promise((resolve) => safeLookup(host, options, (err, address) => resolve({ err, address })));
  const local = await lookup("localhost", {});
  assert.equal(local.err?.code, "EBLOCKED");
  const all = await lookup("localhost", { all: true });
  assert.equal(all.err?.code, "EBLOCKED");
});

test("parses RSS and Atom, newest first", () => {
  const rss = `<rss><channel>
    <item><title>Old</title><link>https://a.example/1</link><pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate></item>
    <item><title>New &amp; shiny</title><link>https://a.example/2</link><pubDate>Tue, 06 Oct 2026 08:00:00 GMT</pubDate><description>&lt;p&gt;Plywood&lt;/p&gt;</description></item>
  </channel></rss>`;
  const items = parseFeed(rss);
  assert.deepEqual(items.map((i) => i.title), ["New & shiny", "Old"]);
  assert.equal(items[0].snippet, "Plywood");
  const atom = `<feed><entry><title>Atom item</title><link href="https://b.example/x"/><updated>2026-10-07T00:00:00Z</updated></entry></feed>`;
  assert.equal(parseFeed(atom)[0].url, "https://b.example/x");
  assert.throws(() => parseFeed("<html></html>"), /Not an RSS/);
});

test("a feed that stalls mid-body times out instead of hanging, compressed or not", async () => {
  const stalled = (encoding, bytes) => {
    const res = Object.assign(new PassThrough(), { headers: encoding ? { "content-encoding": encoding } : {} });
    res.write(bytes);
    return res;
  };
  const gzip = zlib.gzipSync(Buffer.from(`<rss>${"x".repeat(5000)}</rss>`));
  await assert.rejects(readBody(stalled("gzip", gzip.subarray(0, 20)), 50), /timed out/);
  await assert.rejects(readBody(stalled(null, "<rss>"), 50), /timed out/);
  const done = stalled("gzip", gzip);
  done.end();
  assert.match(await readBody(done, 1000), /^<rss>x+<\/rss>$/);
});
