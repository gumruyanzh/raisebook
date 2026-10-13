"""A local fake OpenRouter for development (RESEARCH-PLAN §0): exercise research end to end
without a real key and without spending anything.

Run from ``backend/``::

    uv run python scripts/mock_openrouter.py --port 8787
    RAISEBOOK_OPENROUTER_BASE_URL=http://localhost:8787/api/v1 uv run rbctl worker
    RAISEBOOK_OPENROUTER_BASE_URL=http://localhost:8787/api/v1 uv run uvicorn --factory \\
        raisebook.main:create_app --reload

It answers ``GET /api/v1/models`` (the recorded models list), ``GET /api/v1/key`` (any key
is "valid") and ``POST /api/v1/chat/completions`` with the same canned, fictional answers the
test suite uses (``tests/research/pipeline_mock.py``): every answer is about the fictional
"Dana Whitfield of Harbor Light Ventures" on ``*.example`` pages, so research the sample
workspace's Dana Whitfield (``rbctl seed-demo``) for a full dossier; other investors end
``partial`` (no source matches their identity), which exercises that path too. It only ever
returns made-up text.
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.research.openrouter_mock import models_fixture
from tests.research.pipeline_mock import Script

KEY_INFO = {
    "data": {
        "label": "Local mock key",
        "limit": 25.0,
        "limit_remaining": 25.0,
        "usage": 0.0,
        "is_free_tier": False,
    }
}


class Handler(BaseHTTPRequestHandler):
    script = Script()

    def _send(self, status: int, body: Any) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/api/v1/models":
            self._send(200, models_fixture())
        elif self.path.rstrip("/") == "/api/v1/key":
            self._send(200, KEY_INFO)
        else:
            self._send(404, {"error": {"message": "not mocked"}})

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/api/v1/chat/completions":
            self._send(404, {"error": {"message": "not mocked"}})
            return
        length = int(self.headers.get("Content-Length") or 0)
        request = httpx.Request("POST", "http://mock" + self.path, content=self.rfile.read(length))
        response = self.script.handler(request)
        self._send(response.status_code, response.json())

    def log_message(self, fmt: str, *args: Any) -> None:  # never log request bodies
        sys.stderr.write(f"mock-openrouter {self.command} {self.path}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Fake OpenRouter on http://{args.host}:{args.port}/api/v1 (Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
