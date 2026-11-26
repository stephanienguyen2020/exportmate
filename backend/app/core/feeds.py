"""Reads RSS/Atom feeds safely (a port of ai/server/feeds.js). Feed URLs can be user-supplied,
so only public HTTPS hosts are read: every address the host resolves to is checked, and the
request then connects to that checked address (TLS still verifies the host name), so a host
can't pass the check with a public address and be fetched at a private one (DNS rebinding,
e.g. the metadata server). XML is parsed with defusedxml (no entity expansion)."""

import html
import http.client
import ipaddress
import re
import socket
import ssl
import time
import zlib
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlsplit, urlunsplit
from xml.etree.ElementTree import Element

from defusedxml import ElementTree

MAX_BYTES = 3_000_000  # after decompression
MAX_REDIRECTS = 3
TIMEOUT_SECONDS = 15.0
USER_AGENT = "ExportMateNewsWatch/1.0 (+https://exportmate-web-3v6cd2xhpq-as.a.run.app)"

# NAT64 (DNS64 networks answer with these for IPv4-only hosts): judged by the IPv4 inside.
_NAT64 = ipaddress.ip_network("64:ff9b::/96")


class FeedError(Exception):
    """Why a feed couldn't be read, in words fit for the person who added it."""


def is_blocked_address(text: str) -> bool:
    """True for any address a feed must not be fetched from (and for anything not an IP):
    private, loopback, link-local, shared, documentation, multicast and reserved ranges."""
    try:
        address = ipaddress.ip_address(text.split("%")[0])
    except ValueError:
        return True
    if isinstance(address, ipaddress.IPv6Address):
        inner = address.ipv4_mapped or address.sixtofour
        if inner is None and address in _NAT64:
            inner = ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
        if inner is not None:
            address = inner
    return not address.is_global or address.is_multicast


def check_feed_url(raw: str) -> str:
    """The URL if its shape is allowed; the address itself is checked when connecting."""
    try:
        parts = urlsplit(raw.strip())
        host = parts.hostname
    except ValueError as error:
        raise FeedError("Not a valid URL") from error
    if parts.scheme != "https":
        raise FeedError("Feed URL must use https")
    if not host:
        raise FeedError("Not a valid URL")
    if parts.username or parts.password:
        raise FeedError("Credentials in URLs are not allowed")
    if _is_ip(host) and is_blocked_address(host):
        raise FeedError("Private addresses are not allowed")
    return urlunsplit(parts)


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def _public_address(host: str, port: int) -> str:
    """One address of `host`, after checking every address it resolves to."""
    if _is_ip(host):
        return host
    try:
        found = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise FeedError("Host not found") from error
    addresses = [info[4][0] for info in found]
    if not addresses:
        raise FeedError("Host not found")
    if any(is_blocked_address(a) for a in addresses):
        raise FeedError("Private addresses are not allowed")
    return addresses[0]


class _PinnedConnection(http.client.HTTPSConnection):
    """Connects to an address checked beforehand; TLS verifies the certificate for the host."""

    def __init__(self, host: str, port: int, address: str):
        self.context = ssl.create_default_context()
        super().__init__(host, port, timeout=TIMEOUT_SECONDS, context=self.context)
        self.address = address

    def connect(self) -> None:
        sock = socket.create_connection((self.address, self.port), timeout=TIMEOUT_SECONDS)
        self.sock = self.context.wrap_socket(sock, server_hostname=self.host)


def _decoder(encoding: str):
    if encoding == "gzip":
        return zlib.decompressobj(16 + zlib.MAX_WBITS)
    if encoding == "deflate":
        return zlib.decompressobj()
    return None


def _read(url: str, deadline: float) -> tuple[str, str]:
    """One request to the checked address: ("redirect", target) or ("body", text)."""
    parts = urlsplit(url)
    port = parts.port or 443
    connection = _PinnedConnection(parts.hostname, port, _public_address(parts.hostname, port))
    path = urlunsplit(("", "", parts.path or "/", parts.query, ""))
    try:
        connection.request(
            "GET",
            path,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml",
                "Accept-Encoding": "gzip, deflate",
            },
        )
        response = connection.getresponse()
        location = response.getheader("location")
        if 300 <= response.status < 400 and location:
            return "redirect", urljoin(url, location)
        if not 200 <= response.status < 300:
            raise FeedError(f"HTTP {response.status}")
        decoder = _decoder((response.getheader("content-encoding") or "").lower())
        chunks, size = [], 0
        while chunk := response.read(65536):
            if decoder:
                # At most what is still allowed, plus one byte to tell it went over.
                chunk = decoder.decompress(chunk, MAX_BYTES - size + 1)
            size += len(chunk)
            if size > MAX_BYTES:
                raise FeedError("Feed too large")
            if time.monotonic() > deadline:
                raise FeedError("Feed timed out")
            chunks.append(chunk)
        charset = response.headers.get_content_charset() or "utf-8"
        return "body", b"".join(chunks).decode(charset, errors="replace")
    except TimeoutError as error:
        raise FeedError("Feed timed out") from error
    except (OSError, http.client.HTTPException, zlib.error) as error:
        raise FeedError(f"Couldn't read the feed ({type(error).__name__})") from error
    finally:
        connection.close()


def fetch_feed(raw_url: str, *, limit: int = 25) -> list[dict]:
    """The feed's articles, newest first. Raises FeedError when it can't be read."""
    url = check_feed_url(raw_url)
    deadline = time.monotonic() + TIMEOUT_SECONDS
    for _ in range(MAX_REDIRECTS + 1):
        kind, value = _read(url, deadline)
        if kind == "body":
            return parse_feed(value, limit=limit)
        url = check_feed_url(value)
    raise FeedError("Too many redirects")


def _local(tag: str) -> str:
    """A tag without its namespace: "{http://www.w3.org/2005/Atom}entry" is "entry"."""
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _child(element: Element, *names: str) -> Element | None:
    """The first child named any of `names`, in that order, ignoring namespaces."""
    for name in names:
        for child in element:
            if _local(child.tag) == name:
                return child
    return None


def _strip(text: str) -> str:
    """Plain text: tags out, entities decoded (feeds often escape their HTML), then tags again."""
    text = re.sub(r"<[^>]*>", " ", html.unescape(re.sub(r"<[^>]*>", " ", text)))
    return re.sub(r"\s+", " ", text.replace("\xa0", " ")).strip()


def _text(element: Element | None) -> str:
    return "".join(element.itertext()) if element is not None else ""


def _published(element: Element) -> str | None:
    raw = _text(_child(element, "pubDate", "published", "updated", "date")).strip()
    if not raw:
        return None
    try:
        when = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        try:
            when = datetime.fromisoformat(raw)
        except ValueError:
            return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return when.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _link(element: Element) -> str:
    links = [c for c in element if _local(c.tag) == "link"]
    for link in links:
        if link.get("href") and link.get("rel") != "self":
            return link.get("href").strip()
    if links and links[0].get("href"):
        return links[0].get("href").strip()
    return _text(links[0]).strip() if links else ""


def parse_feed(body: str, *, limit: int = 25) -> list[dict]:
    """RSS (2.0 and 1.0) or Atom XML as articles, newest first."""
    try:
        root = ElementTree.fromstring(body.lstrip("﻿").strip().encode())
    except Exception as error:  # defusedxml raises its own errors for entities and DTDs
        raise FeedError("Not an RSS or Atom feed") from error
    kind = _local(root.tag)
    if kind == "rss":
        channel = _child(root, "channel")
        entries = [c for c in channel if _local(c.tag) == "item"] if channel is not None else []
    elif kind == "feed":
        entries = [c for c in root if _local(c.tag) == "entry"]
    elif kind == "RDF":
        entries = [c for c in root if _local(c.tag) == "item"]
    else:
        raise FeedError("Not an RSS or Atom feed")
    articles = []
    for entry in entries:
        article = {
            "title": _strip(_text(_child(entry, "title")))[:300],
            "url": _link(entry),
            "publishedAt": _published(entry),
            "snippet": _strip(_text(_child(entry, "description", "summary", "encoded", "content")))[
                :600
            ],
            "publisher": _strip(_text(_child(entry, "source"))),
        }
        if article["title"] and re.match(r"^https?://", article["url"]):
            articles.append(article)
    articles.sort(key=lambda a: a["publishedAt"] or "", reverse=True)
    return articles[:limit]
