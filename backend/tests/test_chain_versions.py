"""Material chain versions: the files in git as first versions, a changed file as a draft, and
a chain admin publishing (the graph rebuilt) or rejecting it."""

import copy

import pytest
from conftest import onboard
from sqlalchemy import func, select

from app.core.config import get_settings
from app.database.models import ChainVersion, GraphEdge
from app.database.session import open_session
from app.knowledge_graph import load_released_files
from app.seed_reference_data import seed_reference_data
from app.services import chain_versions

ADMIN = "admin@exportmate.example"


@pytest.fixture
def chain_admins(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CHAIN_ADMIN_EMAILS", f" {ADMIN.upper()} , other@example.com")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def seeded(client) -> dict:
    headers = {"lan": onboard(client, "lan@example.com"), "admin": onboard(client, ADMIN)}
    with open_session() as db:
        seed_reference_data(db)
    return headers


def soya_changed() -> tuple[list[dict], dict]:
    """The files, with soya's chain edited as a rebuild might: one link dropped, one quote
    reworded, one product and link added."""
    files = copy.deepcopy(load_released_files())
    soya = next(f for f in files if f["industry"]["key"] == "soya")
    links = soya["industry"]["links"]
    dropped = links.pop()
    links[0]["quote"] = links[0]["quote"] + " (reworded)"
    soya["industry"]["products"].append(
        {
            "key": "soya-lecithin",
            "name": "Soya lecithin",
            "hsCodes": ["2923.20"],
            "stage": "by-product",
        }
    )
    links.append(
        {
            "from": links[0]["from"],
            "to": "soya-lecithin",
            "relation": "by_product",
            "source": links[0]["source"],
            "quote": "lecithin is obtained from soya bean oil",
        }
    )
    return files, dropped


def edge_count() -> int:
    with open_session() as db:
        return db.scalar(select(func.count()).select_from(GraphEdge))


def test_each_file_is_its_industrys_first_published_version(seeded):
    with open_session() as db:
        versions = db.scalars(select(ChainVersion)).all()
        assert {v.industry for v in versions} == {
            f["industry"]["key"] for f in load_released_files()
        }
        assert {(v.number, v.status.value, v.origin) for v in versions} == {
            (1, "published", "seed")
        }
        # Seeding again adds nothing while the files are unchanged.
        assert chain_versions.sync_from_files(db) == 0


def test_a_changed_file_waits_as_a_draft_and_a_chain_admin_publishes_it(
    client, seeded, chain_admins, monkeypatch
):
    before = edge_count()
    files, dropped = soya_changed()
    monkeypatch.setattr(chain_versions, "load_released_files", lambda: files)
    with open_session() as db:
        assert chain_versions.sync_from_files(db) == 1
        chain_versions.rebuild_graph(db)
        db.commit()
    # A draft changes nothing the graph walks.
    assert edge_count() == before

    chain = client.get("/api/v1/knowledge-graph/chain", headers=seeded["lan"]).json()["data"]
    assert (chain["draftsWaiting"], chain["isChainAdmin"]) == (1, False)
    soya = next(i for i in chain["industries"] if i["key"] == "soya")
    assert soya["version"] == 1 and soya["publishedAt"]
    # Only chain admins see versions (matched case-insensitively).
    denied = client.get("/api/v1/knowledge-graph/chain-versions", headers=seeded["lan"])
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_chain_admin"
    admin = seeded["admin"]
    assert client.get("/api/v1/knowledge-graph/chain", headers=admin).json()["data"]["isChainAdmin"]

    versions = client.get("/api/v1/knowledge-graph/chain-versions", headers=admin).json()["data"]
    draft = versions[0]  # drafts first
    assert (draft["industry"], draft["number"], draft["status"], draft["origin"]) == (
        "soya",
        2,
        "draft",
        "seed",
    )
    assert draft["note"] == "data/industries/soya.json changed in git"

    detail = client.get(f"/api/v1/knowledge-graph/chain-versions/{draft['id']}", headers=admin)
    changes = detail.json()["data"]["changes"]
    assert changes["productsAdded"] == ["Soya lecithin"]
    assert changes["productsRemoved"] == []
    assert [(link["toKey"], link["relation"]) for link in changes["linksAdded"]] == [
        ("soya-lecithin", "by_product")
    ]
    assert [(link["fromKey"], link["toKey"]) for link in changes["linksRemoved"]] == [
        (dropped["from"], dropped["to"])
    ]
    assert [link["changed"] for link in changes["linksChanged"]] == [["quote"]]
    assert changes["linksChanged"][0]["quote"].endswith("(reworded)")

    published = client.post(
        f"/api/v1/knowledge-graph/chain-versions/{draft['id']}/publish",
        headers=admin,
        json={"note": "Lecithin is in Codex too."},
    )
    assert published.status_code == 200, published.text
    body = published.json()["data"]
    assert (body["status"], body["reviewNote"], body["reviewedBy"]) == (
        "published",
        "Lecithin is in Codex too.",
        "admin",
    )
    # Compared with the version it replaced, it still shows what it changed.
    assert body["changes"]["productsAdded"] == ["Soya lecithin"]
    # The graph walks the new version: one link dropped, one added.
    assert edge_count() == before
    with open_session() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(GraphEdge)
                .where(GraphEdge.to_key == "soya.soya-lecithin")
            )
            == 1
        )
        first = db.scalar(
            select(ChainVersion).where(ChainVersion.industry == "soya", ChainVersion.number == 1)
        )
        assert first.status.value == "superseded"
    chain = client.get("/api/v1/knowledge-graph/chain", headers=admin).json()["data"]
    assert next(i for i in chain["industries"] if i["key"] == "soya")["version"] == 2
    assert chain["draftsWaiting"] == 0

    # A version is reviewed once.
    again = client.post(
        f"/api/v1/knowledge-graph/chain-versions/{draft['id']}/publish", headers=admin, json={}
    )
    assert again.status_code == 409


def test_a_chain_admin_rejects_a_draft_with_a_reason(client, seeded, chain_admins, monkeypatch):
    files, _ = soya_changed()
    monkeypatch.setattr(chain_versions, "load_released_files", lambda: files)
    with open_session() as db:
        chain_versions.sync_from_files(db)
        db.commit()
        # The same changed file doesn't make a second draft.
        assert chain_versions.sync_from_files(db) == 0
    admin = seeded["admin"]
    draft = client.get("/api/v1/knowledge-graph/chain-versions", headers=admin).json()["data"][0]
    url = f"/api/v1/knowledge-graph/chain-versions/{draft['id']}/reject"
    assert client.post(url, headers=admin, json={"note": ""}).status_code == 422
    assert client.post(url, headers=seeded["lan"], json={"note": "No."}).status_code == 403
    rejected = client.post(url, headers=admin, json={"note": "Lecithin isn't sourced yet."})
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["data"]["status"] == "rejected"
    soya = next(
        i
        for i in client.get("/api/v1/knowledge-graph/chain", headers=admin).json()["data"][
            "industries"
        ]
        if i["key"] == "soya"
    )
    assert soya["version"] == 1
    missing = client.get(
        "/api/v1/knowledge-graph/chain-versions/00000000-0000-0000-0000-000000000000", headers=admin
    )
    assert missing.status_code == 404
