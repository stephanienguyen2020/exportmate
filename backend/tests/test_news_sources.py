import pytest
from conftest import add_member, onboard
from sqlalchemy import select

from app.core import feeds
from app.core.feeds import FeedError, check_feed_url, is_blocked_address, parse_feed
from app.database.models import AuditEvent, Role
from app.database.session import open_session
from app.services import news_sources as news_source_service

SAMPLE = [
    {
        "title": "Timber prices rise",
        "url": "https://news.example/a",
        "publishedAt": "2026-11-20T08:00:00.000Z",
        "snippet": "Prices rose.",
        "publisher": "",
    }
]
FEED = {"name": "Timber Trade News", "url": "https://news.example/feed"}


@pytest.fixture
def shared(news_store):
    """A built-in source and one added before sources had owners: both shared."""
    news_store.sources["ttj"] = {
        "name": "TTJ",
        "url": "https://www.ttjonline.com/feed/",
        "kind": "Trade press",
        "builtIn": True,
        "enabled": True,
        "lastOk": True,
        "lastCount": 12,
    }
    news_store.sources["old"] = {
        "name": "Old custom",
        "url": "https://old.example/feed",
        "kind": "Custom",
        "builtIn": False,
        "enabled": True,
    }
    return news_store


@pytest.fixture
def readable(monkeypatch):
    read = []
    monkeypatch.setattr(
        news_source_service, "fetch_feed", lambda url, limit: read.append(url) or SAMPLE
    )
    return read


def sources(client, headers=None) -> dict[str, dict]:
    response = client.get("/api/v1/news-sources", headers=headers or {})
    assert response.status_code == 200, response.text
    return {s["id"]: s for s in response.json()["data"]}


def audit_actions() -> list[str]:
    with open_session() as db:
        actions = db.scalars(select(AuditEvent.action).order_by(AuditEvent.created_at))
        return [a for a in actions if a.startswith("news_")]


def test_signed_out_sees_the_shared_sources(client, shared):
    listed = sources(client)
    assert set(listed) == {"old", "ttj"}
    assert listed["ttj"] == {
        "id": "ttj",
        "name": "TTJ",
        "url": "https://www.ttjonline.com/feed/",
        "kind": "Trade press",
        "builtIn": True,
        "shared": True,
        "enabled": True,
        "addedAt": None,
        "lastFetchedAt": None,
        "lastOk": True,
        "lastCount": 12,
        "lastError": None,
    }
    settings = client.get("/api/v1/news-settings").json()["data"]
    assert settings == {"maxAgeDays": 365, "skipOld": True}
    assert client.post("/api/v1/news-sources", json=FEED).status_code == 401


def test_a_company_source_is_its_own(client, shared, readable):
    a = onboard(client, "lan@a.example")
    b = onboard(client, "minh@b.example", company="Other Co.")
    response = client.post("/api/v1/news-sources", headers=a, json=FEED)
    assert response.status_code == 201, response.text
    added = response.json()["data"]
    assert added["sample"][0]["title"] == "Timber prices rise"
    assert added["source"]["shared"] is False and added["source"]["kind"] == "Custom"
    assert readable == [FEED["url"]]
    source_id = added["source"]["id"]
    stored = shared.sources[source_id]
    assert stored["enabled"] is True and stored["companyId"]

    assert source_id in sources(client, a)
    assert source_id not in sources(client, b)
    assert source_id not in sources(client)
    # Another company's source answers like a missing one.
    path = f"/api/v1/news-sources/{source_id}"
    assert client.patch(path, headers=b, json={"enabled": False}).status_code == 404
    assert client.delete(path, headers=b).status_code == 404
    # The same feed again is refused; another company may add it as its own.
    assert client.post("/api/v1/news-sources", headers=a, json=FEED).status_code == 409
    assert client.post("/api/v1/news-sources", headers=b, json=FEED).status_code == 201

    # Its own source is switched off for real, then removed.
    response = client.patch(path, headers=a, json={"enabled": False})
    assert response.json()["data"]["enabled"] is False
    assert shared.sources[source_id]["enabled"] is False
    assert client.delete(path, headers=a).status_code == 200
    assert source_id not in shared.sources
    assert audit_actions() == [
        "news_source.added",
        "news_source.added",
        "news_source.disabled",
        "news_source.deleted",
    ]


def test_switching_a_shared_source_off_affects_only_that_company(client, shared):
    a = onboard(client, "lan@a.example")
    b = onboard(client, "minh@b.example", company="Other Co.")
    response = client.patch("/api/v1/news-sources/ttj", headers=a, json={"enabled": False})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["enabled"] is False
    assert sources(client, a)["ttj"]["enabled"] is False
    assert sources(client, b)["ttj"]["enabled"] is True
    assert sources(client)["ttj"]["enabled"] is True
    assert shared.sources["ttj"]["enabled"] is True
    [settings] = shared.companies.values()
    assert settings["disabled"] == ["ttj"]

    client.patch("/api/v1/news-sources/ttj", headers=a, json={"enabled": True})
    assert sources(client, a)["ttj"]["enabled"] is True
    # Shared sources are switched off, never deleted.
    assert client.delete("/api/v1/news-sources/ttj", headers=a).status_code == 400
    assert client.delete("/api/v1/news-sources/old", headers=a).status_code == 400


def test_only_owners_and_editors_change_sources(client, shared, readable):
    onboard(client, "lan@a.example")
    viewer = add_member(client, "lan@a.example", "thu@a.example", Role.viewer)
    editor = add_member(client, "lan@a.example", "hoa@a.example", Role.editor)
    assert client.post("/api/v1/news-sources", headers=viewer, json=FEED).status_code == 403
    path = "/api/v1/news-sources/ttj"
    assert client.patch(path, headers=viewer, json={"enabled": False}).status_code == 403
    assert (
        client.patch("/api/v1/news-settings", headers=viewer, json={"skipOld": False}).status_code
        == 403
    )
    assert "ttj" in sources(client, viewer)
    assert client.post("/api/v1/news-sources", headers=editor, json=FEED).status_code == 201


def test_a_feed_that_cant_be_read_is_not_added(client, monkeypatch, news_store):
    a = onboard(client, "lan@a.example")

    def unreadable(url, limit):
        raise FeedError("Private addresses are not allowed")

    monkeypatch.setattr(news_source_service, "fetch_feed", unreadable)
    response = client.post("/api/v1/news-sources", headers=a, json=FEED)
    assert response.status_code == 400
    assert response.json()["error"]["message"] == (
        "Couldn't read that feed: Private addresses are not allowed"
    )
    assert news_store.sources == {}


def test_a_company_adds_at_most_ten_sources(client, news_store, readable):
    a = onboard(client, "lan@a.example")
    for n in range(10):
        feed = {"name": f"Feed {n}", "url": f"https://news.example/{n}"}
        assert client.post("/api/v1/news-sources", headers=a, json=feed).status_code == 201
    response = client.post("/api/v1/news-sources", headers=a, json=FEED)
    assert response.status_code == 400
    assert "Up to 10" in response.json()["error"]["message"]


def test_the_age_rule_is_switched_off_for_one_company(client, news_store):
    a = onboard(client, "lan@a.example")
    b = onboard(client, "minh@b.example", company="Other Co.")
    response = client.patch("/api/v1/news-settings", headers=a, json={"skipOld": False})
    assert response.status_code == 200, response.text
    assert response.json()["data"] == {"maxAgeDays": 365, "skipOld": False}
    assert client.get("/api/v1/news-settings", headers=a).json()["data"]["skipOld"] is False
    assert client.get("/api/v1/news-settings", headers=b).json()["data"]["skipOld"] is True
    [settings] = news_store.companies.values()
    assert settings["skipOld"] is False
    assert audit_actions() == ["news_settings.updated"]


@pytest.mark.parametrize(
    ("address", "blocked"),
    [
        ("8.8.8.8", False),
        ("2606:4700::1111", False),
        ("10.0.0.1", True),
        ("127.0.0.1", True),
        ("169.254.169.254", True),  # the metadata server
        ("100.64.0.1", True),
        ("224.0.0.1", True),
        ("::1", True),
        ("fd00::1", True),
        ("::ffff:127.0.0.1", True),  # IPv4-mapped
        ("64:ff9b::a9fe:a9fe", True),  # NAT64 of 169.254.169.254
        ("2002:0a00:0001::", True),  # 6to4 of 10.0.0.1
        ("not-an-ip", True),
    ],
)
def test_feeds_are_read_from_public_addresses_only(address, blocked):
    assert is_blocked_address(address) is blocked


@pytest.mark.parametrize(
    ("url", "error"),
    [
        ("http://news.example/feed", "must use https"),
        ("https://user:pw@news.example/feed", "Credentials"),
        ("https://127.0.0.1/feed", "Private addresses"),
        ("https://[::1]/feed", "Private addresses"),
        ("feed", "must use https"),
    ],
)
def test_feed_urls_are_checked(url, error):
    with pytest.raises(FeedError, match=error):
        check_feed_url(url)


def test_a_host_that_resolves_to_a_private_address_is_refused(monkeypatch):
    monkeypatch.setattr(
        feeds.socket,
        "getaddrinfo",
        lambda host, port, type: [
            (2, 1, 6, "", ("93.184.216.34", port)),
            (2, 1, 6, "", ("10.0.0.5", port)),
        ],
    )
    with pytest.raises(FeedError, match="Private addresses"):
        feeds.fetch_feed("https://rebind.example/feed")


RSS = """<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
<item><title>Older &amp; plain</title><link>https://news.example/1</link>
<pubDate>Mon, 16 Nov 2026 08:00:00 GMT</pubDate>
<description>&lt;p&gt;Escaped &lt;b&gt;HTML&lt;/b&gt;&amp;nbsp;here&lt;/p&gt;</description></item>
<item><title>Newer</title><link>https://news.example/2</link><dc:date>2026-11-20T10:00:00Z</dc:date></item>
<item><title>No link</title></item>
</channel></rss>"""
ATOM = """<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom entry</title>
<link rel="self" href="https://news.example/self"/><link href="https://news.example/atom"/>
<updated>2026-11-18T00:00:00+07:00</updated><summary>Short</summary></entry></feed>"""


def test_rss_and_atom_feeds_are_parsed_newest_first():
    articles = parse_feed(RSS)
    assert [a["title"] for a in articles] == ["Newer", "Older & plain"]
    assert articles[0]["publishedAt"] == "2026-11-20T10:00:00.000Z"
    assert articles[1]["snippet"] == "Escaped HTML here"
    [entry] = parse_feed(ATOM)
    assert entry["url"] == "https://news.example/atom"
    assert entry["publishedAt"] == "2026-11-17T17:00:00.000Z"
    assert parse_feed(RSS, limit=1)[0]["title"] == "Newer"


def test_xml_that_isnt_a_feed_or_expands_entities_is_refused():
    with pytest.raises(FeedError, match="Not an RSS or Atom feed"):
        parse_feed("<html><body>Hi</body></html>")
    bomb = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;">]><rss><channel><item><title>&b;</title></item></channel></rss>'
    with pytest.raises(FeedError):
        parse_feed(bomb)
