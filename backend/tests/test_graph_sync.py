"""Neo4j as the knowledge graph's read model: change events after commits, the walk answered by
Neo4j only while it holds Postgres's chain, and the Pub/Sub push request that syncs a change.
Neo4j itself isn't needed: tests stand in for its driver and queries."""

import base64
import json
import uuid

import pytest
from conftest import import_orders, onboard
from neo4j.exceptions import ServiceUnavailable

from app.core.config import get_settings
from app.database import graph_changes
from app.database.queries import knowledge_graph as graph_queries
from app.database.queries import neo4j_graph
from app.database.queries import users as user_queries
from app.database.queries.knowledge_graph import GraphWalkRow
from app.database.queries.neo4j_graph import Neo4jWalk
from app.database.session import open_session
from app.seed_demo_data import seed_company_map_data
from app.seed_reference_data import seed_reference_data
from app.services import chain_versions, graph_events, graph_store, graph_sync
from app.services.graph_store import GraphStore

ORDERS = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    'PO-1,Acacia plywood 18 mm,Binh Phu Wood,"Rotterdam, NL",24000,2099-10-27,4412.33\n'
)


@pytest.fixture
def lan(client) -> dict:
    headers = onboard(client, "lan@example.com")
    with open_session() as db:
        seed_reference_data(db)
        user = user_queries.get_user_by_firebase_uid(db, "dev:lan@example.com")
        _, company = user_queries.get_user_company_membership(db, user.id)
        seed_company_map_data(db, company.id)
        db.commit()
    import_orders(client, headers, ORDERS)
    return {"headers": headers, "company_id": company.id}


@pytest.fixture
def changes():
    seen: list[graph_changes.GraphChange] = []
    graph_changes.set_change_handler(seen.append)
    yield seen
    graph_events.install()


@pytest.fixture
def neo4j(monkeypatch: pytest.MonkeyPatch) -> dict:
    """A Neo4j that answers with whatever `answer` holds (a Neo4jWalk or an exception)."""
    world: dict = {"answer": None, "calls": 0}

    def walk(driver, start_keys, max_depth):
        world["calls"] += 1
        if isinstance(world["answer"], Exception):
            raise world["answer"]
        return world["answer"]

    monkeypatch.setattr(graph_store, "get_neo4j_driver", lambda: object())
    monkeypatch.setattr(neo4j_graph, "walk_downstream", walk)
    monkeypatch.setattr(graph_store, "_neo4j_skipped_until", 0.0)
    return world


def test_commits_say_what_changed_in_the_graph(client, lan, changes):
    changes.clear()
    # An order edited: its company.
    response = client.patch(
        "/api/v1/orders/PO-1", headers=lan["headers"], json={"product": "Acacia plywood 12 mm"}
    )
    assert response.status_code == 200, response.text
    assert lan["company_id"] in set().union(*(c.company_ids for c in changes))
    assert not any(c.chain for c in changes)

    # A supplier's sourcing replaced in bulk: its supplier, resolved to the company on sync.
    changes.clear()
    with open_session() as db:
        sourcing, supplier = graph_queries.list_company_sourcing(db, lan["company_id"])[0]
        graph_queries.replace_supplier_sourcing(
            db,
            supplier.id,
            [
                {
                    "supplier_id": supplier.id,
                    "material_key": sourcing.material_key,
                    "country_alpha2": sourcing.country_alpha2,
                    "form_key": sourcing.form_key,
                    "basis": "test",
                }
            ],
        )
        db.commit()
        assert changes[-1].supplier_ids == {supplier.id}
        assert graph_queries.list_supplier_company_ids(db, {supplier.id}) == {lan["company_id"]}

    # The graph rebuilt: the shared chain.
    changes.clear()
    with open_session() as db:
        chain_versions.rebuild_graph(db)
        db.commit()
    assert [c.chain for c in changes] == [True]

    # A rolled-back write says nothing.
    changes.clear()
    with open_session() as db:
        chain_versions.rebuild_graph(db)
        db.rollback()
    assert changes == []


def test_a_change_travels_as_a_message():
    change = graph_changes.GraphChange(
        chain=True, company_ids={uuid.uuid4()}, supplier_ids={uuid.uuid4()}
    )
    message = graph_events.change_to_message(change)
    assert graph_events.change_from_message(json.loads(json.dumps(message))) == change


def test_the_fingerprint_is_the_same_in_postgres_and_python(lan):
    with open_session() as db:
        edges = graph_queries.list_all_graph_edges(db)
        assert edges
        assert graph_queries.chain_fingerprint(db) == graph_sync.edges_fingerprint(
            [e.id for e in edges]
        )


def test_neo4j_answers_the_walk_only_while_it_holds_the_same_chain(lan, neo4j):
    starts = {"wood.roundwood"}
    with open_session() as db:
        postgres_rows = graph_queries.walk_downstream(db, starts, 4)
        fingerprint = graph_queries.chain_fingerprint(db)
        from_neo4j = [GraphWalkRow("wood.roundwood", "wood.roundwood", 0, [])]

        neo4j["answer"] = Neo4jWalk(fingerprint, from_neo4j)
        store = GraphStore(db)
        assert store.walk_downstream(starts, 4) == from_neo4j
        assert store.answered_by == {"neo4j"}
        store.walk_downstream(starts, 4)  # the same walk again is kept
        assert neo4j["calls"] == 1

        # Neo4j lags behind a rebuild (another fingerprint) or was never synced: Postgres.
        for stale in ("another", None):
            neo4j["answer"] = Neo4jWalk(stale, from_neo4j)
            store = GraphStore(db)
            assert store.walk_downstream(starts, 4) == postgres_rows
            assert store.answered_by == {"postgres"}

        # Neo4j down (AuraDB Free paused): Postgres, and Neo4j left alone for a while.
        neo4j["answer"] = ServiceUnavailable("paused")
        calls = neo4j["calls"]
        assert GraphStore(db).walk_downstream(starts, 4) == postgres_rows
        assert GraphStore(db).walk_downstream(starts, 4) == postgres_rows
        assert neo4j["calls"] == calls + 1


def test_suggestions_dont_depend_on_the_order_rows_come_in(client, lan, neo4j):
    """Neo4j returns the walk's rows in another order than Postgres: ties between equally good
    paths must still go the same way."""
    params = {"material": "timber"}
    url = "/api/v1/knowledge-graph/query"
    with open_session() as db:
        keys = {n.key for n in graph_queries.list_graph_nodes(db)}
        rows = graph_queries.walk_downstream(db, keys, 4)
        fingerprint = graph_queries.chain_fingerprint(db)
    neo4j["answer"] = ServiceUnavailable("off")
    from_postgres = client.get(url, headers=lan["headers"], params=params).json()["data"]
    for ordered in (rows, list(reversed(rows))):
        neo4j["answer"] = Neo4jWalk(fingerprint, ordered)
        graph_store._neo4j_skipped_until = 0.0
        from_neo4j = client.get(url, headers=lan["headers"], params=params).json()["data"]
        assert from_neo4j["walkedOn"] == ["neo4j"]
        assert from_neo4j["matches"] == from_postgres["matches"]


def test_the_graph_query_says_where_it_walked(client, lan, neo4j):
    neo4j["answer"] = ServiceUnavailable("paused")
    response = client.get(
        "/api/v1/knowledge-graph/query",
        headers=lan["headers"],
        params={"material": "acacia", "country": "VN"},
    )
    data = response.json()["data"]
    assert [m["orderId"] for m in data["matches"]] == ["PO-1"]
    assert data["walkedOn"] == ["postgres"]


@pytest.fixture
def push_settings(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GRAPH_SYNC_AUDIENCE", "https://backend.example")
    monkeypatch.setenv("GRAPH_SYNC_INVOKER", "pubsub-push@example.iam.gserviceaccount.com")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def push(client, token: str | None, message: dict):
    data = base64.b64encode(json.dumps(message).encode()).decode()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.post(
        "/api/v1/internal/graph-sync",
        headers=headers,
        json={"message": {"data": data, "messageId": "1"}, "subscription": "s"},
    )


def test_only_the_pubsub_push_account_may_sync(client, push_settings, monkeypatch):
    synced: list[graph_changes.GraphChange] = []
    monkeypatch.setattr(graph_sync, "sync_change", lambda db, change: synced.append(change))

    def verify(token, request, audience):
        if token == "bad":
            raise ValueError("bad signature")
        assert audience == "https://backend.example"
        return {"email": token, "email_verified": True}

    monkeypatch.setattr(graph_events.id_token, "verify_oauth2_token", verify)
    message = {"chain": True}
    assert push(client, None, message).status_code == 401
    assert push(client, "bad", message).status_code == 401
    assert push(client, "someone@example.com", message).status_code == 403
    invoker = "pubsub-push@example.iam.gserviceaccount.com"
    assert push(client, invoker, message).status_code == 204
    assert synced == [graph_changes.GraphChange(chain=True)]

    # Neo4j failing: 503, so Pub/Sub delivers it again.
    def fail(db, change):
        raise ServiceUnavailable("paused")

    monkeypatch.setattr(graph_sync, "sync_change", fail)
    response = push(client, invoker, message)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "graph_sync_failed"


def test_the_push_endpoint_is_off_without_its_settings(client):
    assert push(client, "anyone", {"chain": True}).status_code == 404
