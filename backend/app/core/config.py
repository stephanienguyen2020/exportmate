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
    # Vercel's proxy function accepts bodies up to about 4.5 MB, so uploads are capped at 4 MB.
    max_upload_bytes: int = 4 * 1024 * 1024
    # Per user per hour (core/rate_limit.py).
    import_uploads_per_hour: int = 60
    regulation_document_uploads_per_hour: int = 60
    # Official texts added by the seed don't pass through Vercel; a whole treaty can be 20+ MB.
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
    app_url: str = "https://exportmate.vercel.app"
    member_invite_days: int = 14
    member_invites_per_hour: int = 30  # per owner
    # Who reviews and publishes material chain versions (shared by every company): emails,
    # comma-separated, matched on the verified sign-in email.
    chain_admin_emails: str = ""
    # AI service origin; company reports read its news alerts with the caller's token.
    ai_service_url: str = "http://127.0.0.1:8080"
    # Gemini on Vertex AI (core/gemini.py), in the project above. Production sets GEMINI_MODEL
    # from Terraform's gemini_model, the model the AI service's news scan uses.
    gemini_model: str = "gemini-3.5-flash"
    gemini_location: str = "global"
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
