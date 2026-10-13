"""Async SQLAlchemy engine and session management (asyncpg).

The engine is created lazily so tests and the CLI can point settings at another
database or schema first. ``db_schema`` sets the connection ``search_path`` so a
whole test run lives in its own schema (``public`` stays on the path for the
``citext`` and ``pg_trgm`` extensions).

``hide_parameters=True`` keeps bound values (investor fields, emails) out of
exception messages and logs (SPEC §8.4).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy import MetaData
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from raisebook.config import Settings, get_settings

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


def normalize_db_url(url: str) -> str:
    """Accept ``postgresql://`` / ``postgres://`` and return an asyncpg URL."""
    for prefix in ("postgresql+asyncpg://", "postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix) :]
    raise ValueError("RAISEBOOK_DATABASE_URL must be a PostgreSQL URL")


def server_settings_for(settings: Settings) -> dict[str, str]:
    out = {"application_name": "raisebook", "timezone": "UTC"}
    if settings.db_schema:
        out["search_path"] = f"{settings.db_schema}, public"
    return out


def build_engine(settings: Settings | None = None, **overrides: Any) -> AsyncEngine:
    s = settings or get_settings()
    kwargs: dict[str, Any] = {
        "pool_size": s.db_pool_size,
        "max_overflow": s.db_max_overflow,
        "pool_recycle": s.db_pool_recycle_s,
        "pool_pre_ping": True,
        "hide_parameters": True,
        "connect_args": {"server_settings": server_settings_for(s)},
    }
    kwargs.update(overrides)
    return create_async_engine(normalize_db_url(s.database_url), **kwargs)


_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None
# Rate-limit counters use their own small pool. A request already holds one connection from the
# main pool when the limiter runs; sharing that pool let a burst of parallel page requests each
# hold one connection while waiting for a second, until every request timed out.
_rl_engine: AsyncEngine | None = None
_engine_installed = False


def get_engine() -> AsyncEngine:
    global _engine, _sessionmaker
    if _engine is None:
        _engine = build_engine()
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    get_engine()
    assert _sessionmaker is not None
    return _sessionmaker


def get_ratelimit_engine() -> AsyncEngine:
    """Engine for rate-limit counters: a separate pool, or the installed engine in tests."""
    global _rl_engine
    if _engine_installed:
        return get_engine()
    if _rl_engine is None:
        _rl_engine = build_engine(pool_size=2, max_overflow=8, pool_timeout=10)
    return _rl_engine


def set_engine(engine: AsyncEngine | None) -> None:
    """Install an engine (tests) or clear it so the next call rebuilds from settings."""
    global _engine, _sessionmaker, _engine_installed
    _engine = engine
    _engine_installed = engine is not None
    _sessionmaker = async_sessionmaker(engine, expire_on_commit=False) if engine else None


async def dispose_engine() -> None:
    global _engine, _sessionmaker, _rl_engine
    if _rl_engine is not None:
        await _rl_engine.dispose()
        _rl_engine = None
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: one session per request. Handlers commit explicitly."""
    async with get_sessionmaker()() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
