"""Runtime settings, read from environment variables prefixed ``KEEL_``."""

from __future__ import annotations

import functools
import pathlib
import secrets

import pydantic
import pydantic_settings

DEFAULT_PORT = 8420  # Unassigned by IANA and clear of common dev-server ports (3000, 5173, 8000, 8080).
DEFAULT_HOME = pathlib.Path.home() / ".keel"


class Settings(pydantic_settings.BaseSettings):
    """All Keel settings. Every field can be set with ``KEEL_<FIELD>`` (case-insensitive)."""

    model_config = pydantic_settings.SettingsConfigDict(env_prefix="KEEL_", env_file=".env", extra="ignore")

    database_url: str = pydantic.Field(
        default=f"sqlite:///{DEFAULT_HOME / 'keel.db'}",
        description="Postgres in production (postgresql+psycopg://...). SQLite only for demo and tests.",
    )
    secret_key: str = pydantic.Field(
        default="",
        description="Signs sessions and encrypts stored connector secrets. Required outside demo mode.",
    )
    base_url: str = f"http://localhost:{DEFAULT_PORT}"
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    demo: bool = False
    run_worker_in_process: bool = pydantic.Field(
        default=True, description="Run the background worker inside the web process (single-node installs)."
    )
    auto_migrate: bool = True
    log_level: str = "info"

    # Model provider. Can also be set in the setup wizard; env wins when set.
    model_provider: str = ""  # anthropic | openai | azure_openai | ollama | claude_code | replay
    model_name: str = ""
    model_api_key: str = ""
    model_base_url: str = ""

    # Slack (Socket Mode: no public URL needed).
    slack_bot_token: str = ""
    slack_app_token: str = ""
    slack_signing_secret: str = ""

    # GitHub: a token, or a GitHub App.
    github_token: str = ""
    github_app_id: str = ""
    github_app_private_key: str = ""
    github_installation_id: str = ""
    github_webhook_secret: str = ""
    github_api_url: str = "https://api.github.com"

    # Enterprise SSO (OIDC).
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    oidc_admin_group: str = ""

    # L4 runbooks run only through an outbound-only runner holding this token.
    runner_token: str = ""

    @property
    def is_sqlite(self) -> bool:
        """True when the database is SQLite (demo/test only)."""
        return self.database_url.startswith("sqlite")

    @property
    def sso_enabled(self) -> bool:
        """True when OIDC issuer and client are configured."""
        return bool(self.oidc_issuer and self.oidc_client_id)

    def effective_secret_key(self) -> str:
        """Return the secret key; in demo mode generate a stable per-home key if none is set."""
        if self.secret_key:
            return self.secret_key
        if not self.demo and not self.is_sqlite:
            raise RuntimeError("KEEL_SECRET_KEY is not set. Generate one with: keel secret")
        key_file = DEFAULT_HOME / "secret.key"
        key_file.parent.mkdir(parents=True, exist_ok=True)
        if not key_file.exists():
            key_file.write_text(secrets.token_urlsafe(48))
            key_file.chmod(0o600)
        return key_file.read_text().strip()


@functools.lru_cache(maxsize=1)
def get() -> Settings:
    """Return the process-wide settings (cached)."""
    return Settings()


def reset() -> None:
    """Drop cached settings (tests and CLI overrides)."""
    get.cache_clear()
