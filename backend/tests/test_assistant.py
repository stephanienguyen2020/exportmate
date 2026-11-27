"""The assistant's chat, audits and memories: what each turn carries to the agents, who reads
which audit, and whose memories."""

import json

import pytest
from conftest import add_member, onboard

from app.core.agents import AgentsError, keep_days_of
from app.core.rate_limit import RateLimiter
from app.database.models import Role
from app.database.queries import users as user_queries
from app.database.session import open_session
from app.seed_demo_data import seed_company_map_data
from app.seed_reference_data import seed_reference_data
from app.services import assistant as assistant_service

QUESTION = {"messages": [{"role": "user", "text": "Which items lack geolocation?"}]}
SESSION = "session-1234"
DEMO = {"orders": [{"id": "PO-1"}], "rules": [{"text": "Hold EU orders"}]}


class FakeAgents:
    def __init__(self):
        self.turns: list[dict] = []
        self.calls: list[tuple[str, dict]] = []
        self.fail = False
        self.memories = {"u": [{"id": "102", "fact": "Prefers short answers."}]}

    def stream_turn(self, turn):
        self.turns.append(turn)
        yield {"type": "step", "step": {"kind": "tool", "name": "query_inventory"}}
        if self.fail:
            raise AgentsError("Agents answered 500")
        yield {
            "type": "done",
            "reply": "PLY-101 [1]",
            "citations": [],
            "audit": {"id": "a1", "status": "ok", "steps": [], "usage": {}},
        }

    def call(self, method, payload):
        self.calls.append((method, payload))
        if method == "list_memories":
            return {"memories": [{"id": "102", "fact": "Prefers short answers."}]}
        return {"deleted": payload["id"] == "102"}

    def memory_keep_days(self):
        return 180


class FakeAssistantStore:
    def __init__(self):
        self.audits: list[dict] = []

    def list_session_audits(self, session_id):
        return [a for a in self.audits if a["sessionId"] == session_id]

    def get_audit(self, audit_id):
        return next((a for a in self.audits if a["id"] == audit_id), None)


@pytest.fixture
def agents(monkeypatch):
    fake = FakeAgents()
    monkeypatch.setattr(assistant_service, "get_agents", lambda: fake)
    monkeypatch.setattr(assistant_service, "_per_client", RateLimiter("questions"))
    monkeypatch.setattr(assistant_service, "_per_instance", RateLimiter("questions here"))
    return fake


@pytest.fixture
def audits(monkeypatch):
    store = FakeAssistantStore()
    monkeypatch.setattr(assistant_service, "get_assistant_store", lambda: store)
    return store


@pytest.fixture
def memory_bank(monkeypatch):
    monkeypatch.setenv("AGENT_RUNTIME", "projects/p/locations/asia-southeast1/reasoningEngines/1")
    assistant_service.get_settings.cache_clear()
    yield
    assistant_service.get_settings.cache_clear()


def chat(client, headers=None, **body):
    response = client.post(
        "/api/v1/assistant/chat",
        headers=headers or {},
        json={"sessionId": SESSION, **QUESTION, **body},
    )
    lines = [json.loads(line) for line in response.text.splitlines() if line.strip()]
    return response, lines


def test_a_demo_chat_streams_the_agents_events_with_the_demo_companys_view(client, agents):
    response, events = chat(client, demo=DEMO)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    assert [e["type"] for e in events] == ["step", "done"]
    [turn] = agents.turns
    # The browser's orders and rules go on as sent: the agents check them (ai/server/orders.js).
    assert turn["demo"] == DEMO and turn["access"] == {"companyId": "sample", "disabled": []}
    assert "company" not in turn and "backendToken" not in turn and turn["requestId"]


def test_a_company_chat_carries_its_profile_and_token_never_the_browsers_data(client, agents):
    lan = onboard(client, "lan@example.com")
    response, events = chat(client, lan, demo=DEMO)
    assert response.status_code == 200 and events[-1]["type"] == "done"
    [turn] = agents.turns
    me = client.get("/api/v1/me", headers=lan).json()["data"]
    assert turn["company"]["company"]["id"] == me["company"]["id"]
    assert turn["user"] == {"id": me["user"]["id"]}
    assert turn["backendToken"] == lan["Authorization"].partition(" ")[2]
    assert turn["access"]["companyId"] == me["company"]["id"] and "demo" not in turn


def test_a_company_chat_carries_the_callers_company_profile_and_sites(client, agents):
    with open_session() as db:
        seed_reference_data(db)
    lan = onboard(client, "lan@example.com")
    client.patch("/api/v1/company", headers=lan, json={"certifications": "FSC Mix, VNTLAS"})
    with open_session() as db:
        user = user_queries.get_user_by_firebase_uid(db, "dev:lan@example.com")
        _, company = user_queries.get_user_company_membership(db, user.id)
        seed_company_map_data(db, company.id)
    viewer = add_member(client, "lan@example.com", "vy@example.com", Role.viewer)
    other = onboard(client, "mai@example.com", company="Other Co")

    chat(client, viewer)
    chat(client, other)
    ours, theirs = (t["company"] for t in agents.turns)
    assert ours["company"]["certifications"] == "FSC Mix, VNTLAS"
    site = {"name": "Your factory", "kind": "factory", "place": "Thu Dau Mot, Binh Duong"}
    assert site in ours["sites"]
    assert theirs["company"]["name"] == "Other Co" and theirs["sites"] == []


def test_a_chat_must_end_with_the_users_question_and_name_its_session(client, agents):
    bad = {"messages": [{"role": "model", "text": "Hi"}]}
    assert (
        client.post("/api/v1/assistant/chat", json={"sessionId": SESSION, **bad}).status_code == 400
    )
    no_session = client.post("/api/v1/assistant/chat", json={"sessionId": "x", **QUESTION})
    assert no_session.status_code == 400
    assert agents.turns == []
    long = [{"role": "user", "text": "x" * 5000, "sources": ["s" * 300] * 20}]
    assert assistant_service.parse_messages(long) == [
        {"role": "user", "text": "x" * 4000, "sources": ["s" * 200] * 12}
    ]


def test_chats_are_limited_per_client(client, agents, monkeypatch):
    monkeypatch.setenv("CHAT_LIMIT_PER_CLIENT", "1")
    assistant_service.get_settings.cache_clear()
    try:
        assert chat(client)[0].status_code == 200
        again = client.post("/api/v1/assistant/chat", json={"sessionId": SESSION, **QUESTION})
        assert again.status_code == 429
    finally:
        assistant_service.get_settings.cache_clear()


def test_without_agents_the_assistant_is_unavailable(client):
    response = client.post("/api/v1/assistant/chat", json={"sessionId": SESSION, **QUESTION})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "assistant_not_configured"


def test_agents_failing_mid_answer_end_the_stream_with_an_error(client, agents):
    agents.fail = True
    _, events = chat(client)
    assert [e["type"] for e in events] == ["step", "error"]
    assert events[-1]["error"] == "The assistant is unavailable right now."


def test_a_company_chats_audits_need_that_company(client, audits):
    lan = onboard(client, "lan@example.com")
    company_id = client.get("/api/v1/me", headers=lan).json()["data"]["company"]["id"]
    minh = onboard(client, "minh@other.example", company="Other Co.")
    step = {"kind": "tool", "name": "get_alerts", "thought": "raw reasoning"}
    audits.audits = [
        {"id": "b", "sessionId": SESSION, "createdAt": "2026-11-26T10:00:02Z", "steps": [step]},
        {"id": "a", "sessionId": SESSION, "createdAt": "2026-11-26T10:00:01Z", "steps": []},
        {
            "id": "c",
            "sessionId": SESSION,
            "companyId": company_id,
            "createdAt": "2026-11-26T10:00:03Z",
        },
        {"id": "x", "sessionId": "other-session", "createdAt": "2026-11-26T10:00:00Z"},
    ]

    def ids(headers=None):
        response = client.get(f"/api/v1/assistant/audits?session={SESSION}", headers=headers or {})
        return [a["id"] for a in response.json()["data"]]

    assert ids() == ["a", "b"]
    assert ids(lan) == ["a", "b", "c"]
    assert ids(minh) == ["a", "b"]
    shown = client.get(f"/api/v1/assistant/audits?session={SESSION}").json()["data"][1]
    assert shown["steps"] == [{"kind": "tool", "name": "get_alerts"}]
    assert client.get("/api/v1/assistant/audits?session=x").status_code == 400


def test_memories_are_the_members_own(client, agents, memory_bank):
    lan = onboard(client, "lan@example.com")
    me = client.get("/api/v1/me", headers=lan).json()["data"]
    listed = client.get("/api/v1/assistant/memories", headers=lan).json()["data"]
    assert listed == {
        "memories": [{"id": "102", "fact": "Prefers short answers.", "updatedAt": None}],
        "enabled": True,
        "keepDays": 180,
    }
    assert agents.calls[0] == (
        "list_memories",
        {"userKey": f"{me['company']['id']}:{me['user']['id']}"},
    )
    assert client.delete("/api/v1/assistant/memories/102", headers=lan).status_code == 200
    assert client.delete("/api/v1/assistant/memories/999", headers=lan).status_code == 404
    assert client.delete("/api/v1/assistant/memories/abc", headers=lan).status_code == 404
    assert client.get("/api/v1/assistant/memories").status_code == 401


def test_without_memory_bank_nothing_is_remembered(client, agents):
    lan = onboard(client, "lan@example.com")
    listed = client.get("/api/v1/assistant/memories", headers=lan).json()["data"]
    assert listed == {"memories": [], "enabled": False, "keepDays": None}
    assert agents.calls == []


def test_memory_keep_days_come_from_the_instances_ttl():
    ttl = {"contextSpec": {"memoryBankConfig": {"ttlConfig": {"defaultTtl": "15552000s"}}}}
    assert keep_days_of(ttl) == 180
    assert keep_days_of({}) is None
