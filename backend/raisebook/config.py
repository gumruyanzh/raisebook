"""Application settings (env prefix ``RAISEBOOK_``, SPEC §10)."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """All runtime configuration. Every field reads ``RAISEBOOK_<NAME>`` from the environment."""

    model_config = SettingsConfigDict(
        env_prefix="RAISEBOOK_", env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # ``RAISEBOOK_ENVIRONMENT`` (or the short ``RAISEBOOK_ENV``; dev/prod/stage are accepted).
    environment: Literal["development", "test", "staging", "production"] = Field(
        "development",
        validation_alias=AliasChoices("RAISEBOOK_ENVIRONMENT", "RAISEBOOK_ENV", "environment"),
    )
    log_level: str = "INFO"
    log_json: bool = True

    # Database (asyncpg URL; plain postgresql:// is normalised in core.database).
    database_url: str = "postgresql+asyncpg://localhost/raisebook_dev"
    db_schema: str | None = None  # search_path override (tests use one schema per run)
    db_pool_size: int = 5
    db_max_overflow: int = 2
    db_pool_recycle_s: int = 300

    # Hosts.
    public_base_url: str = "http://localhost:8000"  # where this API is reachable
    app_url: str = "http://localhost:3000"  # where the web app lives (magic links point here)
    # Comma-separated or a JSON list; empty means none (NoDecode skips the JSON-only parse).
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)

    # Sessions (magic-link sign-in) and API keys.
    session_secret: SecretStr = SecretStr("")
    session_cookie_domain: str | None = None
    session_cookie_secure: bool = True
    session_ttl_hours: int = 24 * 30
    # Absolute lifetime: a session ends this many days after sign-in, however active.
    session_max_days: int = 90
    session_touch_interval_s: int = 300
    magic_link_ttl_minutes: int = 15
    invite_ttl_days: int = 7
    api_key_touch_interval_s: int = 60

    # "Continue with Google" (OpenID Connect). Both unset or empty = the feature is off and
    # the sign-in page hides the button. Redirect URI to register in Google Cloud:
    # {public_base_url}/v1/auth/google/callback
    google_client_id: str | None = None
    google_client_secret: SecretStr | None = None
    google_max_per_window: int = 10  # sign-ins per account per magic_link_ttl_minutes

    # Outbound email (magic links, invites).
    email_backend: Literal["log", "smtp", "memory"] = "log"
    email_from: str = "Raisebook <login@raisebook.org>"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    smtp_starttls: bool = True

    # Owned-workspace cap (anti-abuse). People listed here (operators, the founder) have no cap.
    max_workspaces_per_user: int = 10
    workspace_limit_exempt_emails: Annotated[list[str], NoDecode] = Field(default_factory=list)

    # Rate limits (SPEC §7).
    rate_limit_backend: Literal["postgres", "memory", "off"] = "postgres"

    @field_validator("environment", mode="before")
    @classmethod
    def _short_env(cls, v: object) -> object:
        aliases = {"dev": "development", "prod": "production", "stage": "staging"}
        return aliases.get(v, v) if isinstance(v, str) else v

    @field_validator("cors_origins", "workspace_limit_exempt_emails", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            raw = v.strip()
            if raw.startswith("["):
                return json.loads(raw)
            return [p.strip() for p in raw.split(",") if p.strip()]
        return v

    @property
    def is_production(self) -> bool:
        return self.environment in ("production", "staging")

    @property
    def is_dev(self) -> bool:
        return self.environment in ("development", "test")

    @property
    def echo_magic_links(self) -> bool:
        """Return and log sign-in links (``dev_link``) only in development/test *and* when
        the API is served from a local host, so a deploy that forgot
        ``RAISEBOOK_ENVIRONMENT`` still never hands out sign-in links."""
        host = (urlsplit(self.public_base_url).hostname or "").lower()
        return self.is_dev and host in ("localhost", "127.0.0.1", "::1", "testserver")


@lru_cache
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    """Drop the cached settings (tests mutate the environment and call this)."""
    get_settings.cache_clear()
