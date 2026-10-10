"""Alembic environment (async, asyncpg).

The database URL and optional schema come from ``RAISEBOOK_*`` settings. When a
schema is set (tests pass ``config.attributes["schema"]``), every connection runs
with ``search_path=<schema>, public`` and the version table lives in that schema.
A caller may also pass an open connection via ``config.attributes["connection"]``.
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

import raisebook.models  # noqa: F401  (registers tables)
from alembic import context
from raisebook.config import get_settings
from raisebook.core.database import Base, normalize_db_url

config = context.config
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _schema() -> str | None:
    return config.attributes.get("schema") or get_settings().db_schema


def include_name(name: str | None, type_: str, parent_names: object) -> bool:
    return not (type_ == "table" and name == "alembic_version")


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        version_table_schema=_schema(),
        compare_type=True,
        compare_server_default=False,
        include_name=include_name,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    schema = _schema()
    server_settings = {"search_path": f"{schema}, public"} if schema else {}
    engine = create_async_engine(
        normalize_db_url(get_settings().database_url),
        connect_args={"server_settings": server_settings},
    )
    async with engine.connect() as connection:
        await connection.run_sync(do_run_migrations)
        await connection.commit()
    await engine.dispose()


def run_migrations_offline() -> None:
    context.configure(
        url=normalize_db_url(get_settings().database_url),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    existing = config.attributes.get("connection")
    if existing is not None:
        do_run_migrations(existing)
    else:
        asyncio.run(run_async_migrations())
