"""iCalendar (RFC 5545) text for meetings: one event (a download) or a feed (a subscription).

Times are written in UTC (``…Z``) so every calendar app shows them in the viewer's own
timezone. Text values are escaped (backslash, semicolon, comma, newline) and lines are folded
at 75 octets. ``UID`` is stable per meeting and ``SEQUENCE`` grows with every change, so a
subscribed calendar updates a rescheduled meeting in place and drops a cancelled one.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime

PRODID = "-//Raisebook//Meetings//EN"


@dataclass(frozen=True)
class IcsEvent:
    uid: str
    sequence: int
    starts_at: datetime
    ends_at: datetime
    summary: str
    dtstamp: datetime
    location: str | None = None
    description: str | None = None
    url: str | None = None
    cancelled: bool = False


def _stamp(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def escape(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", "\\n")
    )


def fold(line: str) -> str:
    """Fold a content line at 75 octets (continuation lines start with one space)."""
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    parts: list[str] = []
    current = b""
    limit = 75
    for ch in line:
        b = ch.encode("utf-8")
        if len(current) + len(b) > limit:
            parts.append(current.decode("utf-8"))
            current = b""
            limit = 74  # the leading space counts
        current += b
    parts.append(current.decode("utf-8"))
    return "\r\n ".join(parts)


def _event_lines(e: IcsEvent) -> list[str]:
    lines = [
        "BEGIN:VEVENT",
        f"UID:{e.uid}",
        f"DTSTAMP:{_stamp(e.dtstamp)}",
        f"SEQUENCE:{max(0, e.sequence)}",
        f"DTSTART:{_stamp(e.starts_at)}",
        f"DTEND:{_stamp(e.ends_at)}",
        f"SUMMARY:{escape(e.summary)}",
        f"STATUS:{'CANCELLED' if e.cancelled else 'CONFIRMED'}",
    ]
    if e.location:
        lines.append(f"LOCATION:{escape(e.location)}")
    if e.description:
        lines.append(f"DESCRIPTION:{escape(e.description)}")
    if e.url:
        lines.append(f"URL:{e.url}")
    lines.append("END:VEVENT")
    return lines


def calendar(events: Iterable[IcsEvent], *, name: str | None = None, method: bool = False) -> str:
    """A VCALENDAR with ``events``. ``name`` sets the feed's display name; ``method`` adds
    ``METHOD:PUBLISH`` (for a single downloaded event)."""
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", f"PRODID:{PRODID}", "CALSCALE:GREGORIAN"]
    if method:
        lines.append("METHOD:PUBLISH")
    if name:
        lines.append(f"X-WR-CALNAME:{escape(name)}")
        lines.append("REFRESH-INTERVAL;VALUE=DURATION:PT1H")
        lines.append("X-PUBLISHED-TTL:PT1H")
    for e in events:
        lines.extend(_event_lines(e))
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(line) for line in lines) + "\r\n"
