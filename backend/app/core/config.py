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
    max_upload_bytes: int = 5 * 1024 * 1024
    max_import_rows: int = 10_000

    @model_validator(mode="after")
    def no_dev_auth_in_production(self):
        if self.env == "production" and self.auth_mode != "firebase":
            raise ValueError("AUTH_MODE must be 'firebase' when ENV=production")
        return self

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
