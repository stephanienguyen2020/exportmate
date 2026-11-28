from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/.env, wherever the command is run from. Real environment variables win over it.
ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")

    env: Literal["development", "test", "production"] = "development"
    database_url: str = "postgresql+psycopg://exportmate:exportmate@127.0.0.1:5433/exportmate"
    # Only used by pytest; the test run drops and re-creates this database's schema.
    test_database_url: str = (
        "postgresql+psycopg://exportmate:exportmate@127.0.0.1:5433/exportmate_test"
    )
    auth_mode: Literal["firebase", "dev"] = "firebase"
    firebase_project_id: str = "skilful-scarab-511320-q9"
    allowed_origins: str = "http://127.0.0.1:5173,http://localhost:5173"
    # Uploads are capped at 4 MB; the website's nginx takes 5 MB, room for the multipart envelope.
    max_upload_bytes: int = 4 * 1024 * 1024
    # Per user per hour (core/rate_limit.py).
    import_uploads_per_hour: int = 60
    regulation_document_uploads_per_hour: int = 60
    # Official texts added by the seed don't pass through the website; a whole treaty can be 20+ MB.
    max_shared_document_bytes: int = 50 * 1024 * 1024
    max_import_rows: int = 10_000
    # Cloud Storage bucket for uploaded regulation texts and articles.
    regulation_document_bucket: str = ""
    # "json" gives one JSON object per line, which Cloud Logging parses into fields.
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_format: Literal["text", "json"] | None = None  # default: json in production
    # Lets Cloud Logging group log lines by request (X-Cloud-Trace-Context).
    google_cloud_project: str | None = None
    # Suppliers and sites this close to an observed flood extent get a check-in prompt.
    flood_check_radius_km: float = 25.0
    # Order reports by email (core/email.py). No Resend key: sandbox, nothing is delivered.
    resend_api_key: str = ""
    report_email_from: str = "ExportMate <reports@exportmate.app>"
    report_emails_per_hour: int = 20
    # The public contact form (POST /contact) is emailed here; empty: the form is switched off.
    contact_inbox: str = ""
    contact_messages_per_hour: int = 5  # per visitor IP, counted per instance
    # Team invitations (services/members.py): the link in the email, and how long it is valid.
    app_url: str = "https://exportmate-web-3v6cd2xhpq-as.a.run.app"
    member_invite_days: int = 14
    member_invites_per_hour: int = 30  # per owner
    # Who reviews and publishes material chain versions (shared by every company): emails,
    # comma-separated, matched on the verified sign-in email.
    chain_admin_emails: str = ""
    # Neo4j (AuraDB), the knowledge graph's read model (services/graph_sync.py, graph_store.py).
    # No URI: the walk uses Postgres only and nothing is synced.
    neo4j_uri: str = ""
    neo4j_username: str = "neo4j"
    neo4j_password: str = ""
    neo4j_database: str = "neo4j"
    # Pub/Sub topic ("projects/<p>/topics/<t>") for graph change events after each commit; its
    # push subscription calls POST /internal/graph-sync with an OIDC token for this audience,
    # signed as this service account. No topic: the changes are synced in-process.
    graph_events_topic: str = ""
    graph_sync_audience: str = ""
    graph_sync_invoker: str = ""
    # News watch (services/news_sources.py, news_scan.py): its records are in the Firestore of
    # google_cloud_project, which the AI service's assistant also reads. A scan skips articles
    # older than this many days unless a company switched that off (0: no rule).
    scan_max_age_days: int = 365
    # The assistant's agents (core/agents.py, ai/server/runtime.js): "runtime" for the Agent
    # Runtime instance AGENT_RUNTIME (projects/<p>/locations/<l>/reasoningEngines/<id>), or the URL
    # of a local runtime.js (`npm run dev` in ai/server, http://127.0.0.1:8080). Empty: no assistant.
    agents_at: str = ""
    agent_runtime: str = ""
    # Chats per hour, counted in memory per instance: per client address, and in all. Each chat
    # makes several Gemini calls and a signed-out visitor may chat too.
    chat_limit_per_client: int = 40
    chat_limit_per_instance: int = 200
    # Whose goods a signed-out visitor (the browser demo) watches: a company like any other in
    # Firestore (`companyGoods/<id>`, the AI service's `npm run seed` writes its sample stock),
    # with no Postgres account. The AI service's DEMO_COMPANY_ID must match.
    demo_company_id: str = "sample"
    # The Cloud Run job that runs a scan ("projects/<p>/locations/<r>/jobs/<name>"); "Scan now"
    # starts it. Empty (locally): the scan runs in this process.
    news_scan_job: str = ""
    # The scan's Gemini calls think longer than the backend's other steps, and take longer.
    gemini_thinking_scan: str = "MEDIUM"
    scan_gemini_timeout_seconds: int = 240
    # Model Armor screens new articles ("projects/<p>/locations/<l>/templates/<id>"); empty: off.
    model_armor_template: str = ""
    # The assistant's search (core/rag_index.py): RAG Engine corpora and the bucket they import
    # from, as the AI service's RAG_BUCKET / RAG_LOCATION / RAG_EMBED_MODEL. No bucket: the
    # scan doesn't index.
    rag_bucket: str = ""
    rag_location: str = "asia-southeast1"
    rag_embed_model: str = "text-multilingual-embedding-002"
    # Gemini on Vertex AI (core/gemini.py), in the project above. Production sets GEMINI_MODEL
    # from Terraform's gemini_model, the model the AI service's news scan uses.
    gemini_model: str = "gemini-3.5-flash"
    gemini_location: str = "global"
    # Another project whose Gemini quota to use (GEMINI_PROJECT); empty: the project above.
    gemini_project: str = ""
    # How long the model reasons first. Each answer is a fixed JSON shape that code checks, so
    # LOW is enough; the model's default took 29 s for a what-if note. 2.x models refuse a level
    # and get none.
    gemini_thinking_level: str = "LOW"
    # Per attempt. A call that stalls (Gemini sometimes hangs until its deadline) or fails with
    # a transient error is tried again, up to gemini_attempts in all. Together they stay inside
    # the website proxy's wait for the backend (frontend/api/backend.ts, 55 s).
    gemini_timeout_seconds: int = 25
    gemini_attempts: int = 2
    # Embeddings for HS heading and document search; same model as ai/server's vector index.
    embedding_model: str = "gemini-embedding-001"
    # Where embeddings run: the global endpoint doesn't serve the embedding model (404), so
    # embeddings run in a region, the one everything else runs in.
    embedding_location: str = "asia-southeast1"
    # Per user per hour.
    supplier_document_uploads_per_hour: int = 60
    # Each one is an AI call.
    supplier_message_drafts_per_hour: int = 30
    requirement_drafts_per_hour: int = 20
    hs_suggestions_per_hour: int = 60
    scenario_suggestions_per_hour: int = 30
    solution_suggestions_per_hour: int = 30
    analysis_runs_per_hour: int = 60
    # A saved solution is offered for later orders for this many days (or until the day before
    # its requirement's stated change, or until the requirement cites another version).
    solution_valid_days: int = 90
    # How far ahead Rule watch looks for checklist lines that take effect or change.
    rule_watch_days: int = 90
    # The most orders one status change by hand may set at once (PATCH /orders/status).
    max_status_change_orders: int = 500
    # Trade risk backfill (core/trade_risk_job.py): a pair with no score yet starts the Order
    # features job for it. In production the Cloud Run job ("projects/<p>/locations/<l>/jobs/<j>");
    # locally a command run in trade_risk_job_dir, e.g.
    # "uv run python -m trade_risk.order_features". Neither: nothing starts, the monthly run scores it.
    trade_risk_job: str = ""
    trade_risk_job_command: str = ""
    trade_risk_job_dir: str = "../ml"

    @model_validator(mode="after")
    def no_dev_auth_in_production(self):
        if self.env == "production" and self.auth_mode != "firebase":
            raise ValueError("AUTH_MODE must be 'firebase' when ENV=production")
        return self

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]

    @property
    def resolved_log_format(self) -> Literal["text", "json"]:
        return self.log_format or ("json" if self.env == "production" else "text")


@lru_cache
def get_settings() -> Settings:
    return Settings()
