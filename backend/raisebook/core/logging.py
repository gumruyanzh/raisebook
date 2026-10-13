"""structlog configuration with the no-PII rules (SPEC §8.4).

Logs carry request id, method, route template, status, duration, workspace id,
actor type and key prefix. They never carry request bodies, query strings,
investor fields, emails (hash them with :func:`hash_email`) or tokens.

``redact_secrets`` is a last line of defence: it replaces values under sensitive
keys (``token``, ``secret``, ``password``, ``authorization``, ``cookie``,
``api_key``, ``email``, ``kek``…) and scrubs bearer tokens, Raisebook and OpenRouter keys
and email addresses embedded in free text.
"""

from __future__ import annotations

import hashlib
import logging
import re
import sys
import traceback
from collections.abc import Mapping, MutableMapping
from typing import Any

import structlog

REDACTED = "[REDACTED]"

SENSITIVE_KEY_RE = re.compile(
    r"(token|secret|authorization|signature|password|api[_-]?key|cookie|csrf|^email$|"
    r"^body$|^notes?$|magic_link|dev_link|openrouter_key|kek)",
    re.IGNORECASE,
)
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_VALUE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE), "Bearer " + REDACTED),
    # A full key has 32 chars after the prefix; the 12-char display prefix stays readable.
    (re.compile(r"rb_(live|test)_[A-Za-z0-9]{8,}"), r"rb_\1_" + REDACTED),
    # OpenRouter keys (sk-or-v1-…): a workspace's own key never reaches a log line.
    (re.compile(r"sk-or-(?:v1-)?[A-Za-z0-9_-]{16,}"), "sk-or-" + REDACTED),
    (re.compile(r"([?&]token=)[^&\s]+"), r"\1" + REDACTED),
    (_EMAIL_RE, "[EMAIL]"),
)


def hash_email(email: str) -> str:
    """A short stable hash for log lines that must correlate one address."""
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()[:16]


def redact_text(value: str) -> str:
    for pattern, repl in _VALUE_PATTERNS:
        value = pattern.sub(repl, value)
    return value


def _redact(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        return value
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, Mapping):
        return {
            k: (
                REDACTED
                if isinstance(k, str) and SENSITIVE_KEY_RE.search(k)
                else _redact(v, depth + 1)
            )
            for k, v in value.items()
        }
    if isinstance(value, list | tuple):
        return type(value)(_redact(v, depth + 1) for v in value)
    if isinstance(value, bytes | bytearray):
        return f"<{len(value)} bytes>"
    return value


def redact_secrets(
    _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """structlog processor: redact sensitive keys and token- or email-shaped substrings."""
    for key in list(event_dict.keys()):
        if key in ("level", "timestamp", "logger"):
            continue
        if key == "event":
            if isinstance(event_dict[key], str):
                event_dict[key] = redact_text(event_dict[key])
            continue
        if SENSITIVE_KEY_RE.search(key):
            event_dict[key] = REDACTED
        else:
            event_dict[key] = _redact(event_dict[key])
    return event_dict


def safe_traceback(exc: BaseException) -> str:
    """Frames only (file, line, function): no exception message, which may carry data."""
    frames = traceback.extract_tb(exc.__traceback__)
    return " | ".join(f"{f.filename.rsplit('/', 1)[-1]}:{f.lineno}:{f.name}" for f in frames)


def configure_logging(level: str = "INFO", json: bool = True) -> None:
    shared: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        redact_secrets,
    ]
    renderer: Any = structlog.processors.JSONRenderer() if json else structlog.dev.ConsoleRenderer()
    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared,
        processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, renderer],
    )
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())
    # Uvicorn's access log prints raw paths with query strings: replaced by AccessLogMiddleware.
    logging.getLogger("uvicorn.access").disabled = True
    # HTTP client libraries log full URLs (query strings may carry tokens).
    for name in ("httpx", "httpcore", "mcp.server.lowlevel.server", "mcp.server.streamable_http"):
        logging.getLogger(name).setLevel(logging.WARNING)
