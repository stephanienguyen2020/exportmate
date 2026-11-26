"""Adds the news scan's articles and alerts, and the news sources, to the assistant's search on
Agent Platform RAG Engine. The AI service (ai/server/rag.js) searches it and also indexes stock
items and help guides; both write the same records.

Each record is one text file in Cloud Storage (RAG_BUCKET), imported into the corpus for its
type (`exportmate-kb-<type>`, made by the AI service), and Firestore `rag_files` keeps its
metadata, the hash of its text and which RAG file holds it, so a search can check who may see
a result. Only records whose text changed are written and imported; the files they replace are
then removed."""

import hashlib
import secrets
import time
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Protocol
from urllib.parse import quote, unquote

import google.auth
from google.auth.transport.requests import AuthorizedSession

TYPES = ["item", "alert", "article", "source", "guide"]
OPERATION_POLL_SECONDS = 3
TIMEOUT_SECONDS = 60


def _hash(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()


def _day(iso: str | None) -> str:
    return iso[:10] if iso else "undated"


def _number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _origin(record: dict) -> dict:
    """Which sources a record came from, their owners and the article's age when scanned, so
    a search only returns what the asking company may see."""
    origin: dict = {}
    if record.get("sourceIds"):
        origin["sourceIds"] = record["sourceIds"]
    elif record.get("sourceId"):
        origin["sourceIds"] = [record["sourceId"]]
    if record.get("sourceCompanyIds"):
        origin["sourceCompanyIds"] = record["sourceCompanyIds"]
    if _number(record.get("ageDays")):
        origin["ageDays"] = record["ageDays"]
    return origin


def article_doc(article: dict) -> dict:
    publisher = article.get("publisher") or article.get("sourceName")
    return {
        "id": f"article:{article['id']}",
        "type": "article",
        "refId": article["id"],
        **_origin(article),
        "title": article.get("title"),
        "url": article.get("url"),
        "publishedAt": article.get("publishedAt"),
        "source": publisher,
        "text": f"{article.get('title')}. Published {_day(article.get('publishedAt'))} by "
        f"{publisher} (via {article.get('sourceName')}). {article.get('snippet') or ''}",
    }


def alert_doc(alert: dict) -> dict:
    """An alert carries its companyId: only that company sees it."""
    ref = alert.get("impactId") or alert["articleId"]
    affected = "; ".join(f"{x['sku']} {x['name']} ({x['reason']})" for x in alert["affected"])
    value = alert.get("stockValueUsd")
    exposed = f"Stock value exposed USD {value}. " if _number(value) else ""
    return {
        "id": f"alert:{ref}",
        "type": "alert",
        "refId": ref,
        **_origin(alert),
        "companyId": alert.get("companyId"),
        "title": alert.get("headline"),
        "url": alert.get("url"),
        "publishedAt": alert.get("publishedAt"),
        "source": alert.get("publisher"),
        "text": f"News alert, {alert['severity']} severity, {alert['direction']}: "
        f"{alert['headline']}. {alert['why']} "
        f"Affected goods: {affected}. "
        f'{exposed}Next step: {alert["action"]} Source article: "{alert.get("title")}", '
        f"{alert.get('publisher')}, {_day(alert.get('publishedAt'))}.",
    }


def source_doc(source: dict) -> dict:
    shared = bool(source.get("builtIn")) or not source.get("companyId")
    return {
        "id": f"source:{source['id']}",
        "type": "source",
        "refId": source["id"],
        "sourceIds": [source["id"]],
        "sourceCompanyIds": [None if shared else source["companyId"]],
        "title": source.get("name"),
        "url": source.get("url"),
        "text": f'News source "{source.get("name")}" ({source.get("kind")}), '
        f"{'enabled' if source.get('enabled') else 'disabled'}, feed {source.get('url')}. "
        f"{'Built-in source.' if source.get('builtIn') else 'Custom source added by the user.'}",
    }


class RagRecords(Protocol):
    """Firestore `rag_files` (database/news_store.py)."""

    def get_rag_records(self, ids: list[str]) -> dict[str, dict]: ...
    def save_rag_records(self, records: dict[str, dict]) -> None: ...
    def list_rag_ids(self, doc_type: str) -> list[str]: ...
    def delete_rag_records(self, ids: list[str]) -> None: ...


class RagFiles(Protocol):
    """Cloud Storage and RAG Engine."""

    embedding_model: str

    def import_files(self, doc_type: str, files: dict[str, str]) -> dict[str, str | None]: ...
    def remove_files(self, records: Iterable[dict]) -> None: ...


class RagEngine:
    def __init__(self, project: str, location: str, bucket: str, embedding_model: str):
        credentials, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        self.session = AuthorizedSession(credentials)
        self.parent = f"projects/{project}/locations/{location}"
        self.base = f"https://{location}-aiplatform.googleapis.com/v1/"
        self.bucket = bucket
        self.embedding_model = embedding_model
        self._corpora: dict[str, str] | None = None

    def _call(self, method: str, url: str, **kwargs) -> dict:
        response = self.session.request(method, url, timeout=TIMEOUT_SECONDS, **kwargs)
        response.raise_for_status()
        return response.json() if response.content else {}

    def _done(self, operation: dict) -> dict:
        while not operation.get("done"):
            time.sleep(OPERATION_POLL_SECONDS)
            operation = self._call("GET", self.base + operation["name"])
        if operation.get("error"):
            raise RuntimeError(
                f"RAG Engine: {operation['error'].get('message', operation['error'])}"
            )
        return operation.get("response") or {}

    def _corpus(self, doc_type: str) -> str:
        """The corpus for a type, by its display name. The AI service creates them."""
        if self._corpora is None or doc_type not in self._corpora:
            found: dict[str, str] = {}
            page = ""
            while True:
                listed = self._call(
                    "GET", f"{self.base}{self.parent}/ragCorpora?pageSize=100&pageToken={page}"
                )
                for corpus in listed.get("ragCorpora", []):
                    name = corpus.get("displayName", "")
                    if name.startswith("exportmate-kb-") and name[14:] in TYPES:
                        found[name[14:]] = corpus["name"]
                page = listed.get("nextPageToken", "")
                if not page:
                    break
            self._corpora = found
        if doc_type not in self._corpora:
            raise RuntimeError(
                f"No RAG corpus exportmate-kb-{doc_type}; run the AI service's index"
            )
        return self._corpora[doc_type]

    def _files(self, corpus: str) -> list[dict]:
        files: list[dict] = []
        page = ""
        while True:
            listed = self._call(
                "GET", f"{self.base}{corpus}/ragFiles?pageSize=100&pageToken={page}"
            )
            files += listed.get("ragFiles", [])
            page = listed.get("nextPageToken", "")
            if not page:
                return files

    def import_files(self, doc_type: str, files: dict[str, str]) -> dict[str, str | None]:
        """Writes {Cloud Storage path: text} under one folder, imports the folder and returns
        which RAG file holds each path."""
        corpus = self._corpus(doc_type)
        folder = next(iter(files)).rsplit("/", 1)[0] + "/"
        for path, text in files.items():
            self._call(
                "POST",
                f"https://storage.googleapis.com/upload/storage/v1/b/{self.bucket}/o"
                f"?uploadType=media&name={quote(path, safe='')}",
                data=text.encode(),
                headers={"Content-Type": "text/plain; charset=utf-8"},
            )
        self._done(
            self._call(
                "POST",
                f"{self.base}{corpus}/ragFiles:import",
                json={
                    "import_rag_files_config": {
                        "gcs_source": {"uris": [f"gs://{self.bucket}/{folder}"]},
                        # One record is one chunk: they are short, and a result should be a
                        # whole record.
                        "rag_file_transformation_config": {
                            "rag_file_chunking_config": {
                                "fixed_length_chunking": {"chunk_size": 1024, "chunk_overlap": 0}
                            }
                        },
                    }
                },
            )
        )
        by_uri = {
            uri: f["name"]
            for f in self._files(corpus)
            for uri in f.get("gcsSource", {}).get("uris", [])
        }
        return {path: by_uri.get(f"gs://{self.bucket}/{path}") for path in files}

    def remove_files(self, records: Iterable[dict]) -> None:
        for record in records:
            if record.get("ragFile"):
                self._delete(self.base + record["ragFile"])
            if record.get("gcsPath"):
                self._delete(
                    f"https://storage.googleapis.com/storage/v1/b/{self.bucket}/o/"
                    + quote(record["gcsPath"], safe="")
                )

    def _delete(self, url: str) -> None:
        response = self.session.delete(url, timeout=TIMEOUT_SECONDS)
        if response.status_code != 404:
            response.raise_for_status()


def _file_name(doc_id: str) -> str:
    """A record id as a file name ("article:abc" -> "article%3Aabc.txt"), as rag.js names it."""
    return quote(doc_id, safe="~()*!.'") + ".txt"


def record_id(file_name: str) -> str:
    return unquote(file_name.rsplit("/", 1)[-1].removesuffix(".txt"))


def index_docs(docs: list[dict], records: RagRecords, files: RagFiles) -> dict:
    """Upserts documents: only those whose text changed are written and imported, one folder
    (one import) per type; the files they replace are then removed."""
    if not docs:
        return {"imported": 0, "unchanged": 0}
    existing = records.get_rag_records([d["id"] for d in docs])
    changed = [d for d in docs if (existing.get(d["id"]) or {}).get("textHash") != _hash(d["text"])]
    if not changed:
        return {"imported": 0, "unchanged": len(docs)}
    run = f"{_base36(int(time.time() * 1000))}-{secrets.token_hex(3)}"
    for doc_type in TYPES:
        batch = [d for d in changed if d["type"] == doc_type]
        if not batch:
            continue
        folder = f"kb/{doc_type}/{run}/"
        paths = {d["id"]: folder + _file_name(d["id"]) for d in batch}
        held = files.import_files(
            doc_type, {paths[d["id"]]: f"{d['title']}\n\n{d['text']}" for d in batch}
        )
        now = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        records.save_rag_records(
            {
                d["id"]: {
                    **{k: v for k, v in d.items() if k != "id" and v is not None},
                    "textHash": _hash(d["text"]),
                    "ragFile": held.get(paths[d["id"]]),
                    "gcsPath": paths[d["id"]],
                    "embeddingModel": files.embedding_model,
                    "indexedAt": now,
                }
                for d in batch
            }
        )
        files.remove_files(existing[d["id"]] for d in batch if d["id"] in existing)
    return {"imported": len(changed), "unchanged": len(docs) - len(changed)}


def sync_source_docs(sources: list[dict], records: RagRecords, files: RagFiles) -> dict:
    """Brings the sources' search records up to date (the backend adds, switches and removes
    sources): unchanged ones are skipped, removed ones dropped."""
    result = index_docs([source_doc(s) for s in sources], records, files)
    keep = {f"source:{s['id']}" for s in sources}
    stale = [i for i in records.list_rag_ids("source") if i not in keep]
    gone = records.get_rag_records(stale)
    files.remove_files(gone.values())
    records.delete_rag_records(list(gone))
    return {**result, "removed": len(gone)}


def _base36(number: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while number:
        number, rest = divmod(number, 36)
        out = digits[rest] + out
    return out or "0"
