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
    firebase_project_id: str = "exportmate-app"
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
    # AI service origin; company reports read its news alerts with the caller's token.
    ai_service_url: str = "http://127.0.0.1:8080"
    # Gemini on Vertex AI (core/gemini.py), in the project above.
    gemini_model: str = "gemini-2.5-flash"
    gemini_location: str = "global"
    gemini_timeout_seconds: int = 90
    # Per user per hour.
    supplier_document_uploads_per_hour: int = 60
    analysis_runs_per_hour: int = 60

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
