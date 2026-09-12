#!/usr/bin/env python3
"""Tiny relay for EvE-Scout's public Thera / Turnur feed.

Why: some container networks cannot complete a TLS handshake with
api.eve-scout.com (Azure Front Door), while others on the same host can. This
runs as a small private service on a network that can, and serves the identical
JSON to Nexum over plain HTTP on the internal network. Standard library only.

    GET /                          -> "ok" (health check)
    GET /v2/public/signatures[?..] -> upstream JSON, cached CACHE_TTL_SECONDS,
                                      last good copy served if upstream fails

Env: PORT (8080), UPSTREAM (https://api.eve-scout.com), CACHE_TTL_SECONDS (60),
UPSTREAM_TIMEOUT_SECONDS (20), UPSTREAM_RETRIES (2).
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM  = os.environ.get("UPSTREAM", "https://api.eve-scout.com").rstrip("/")
PORT      = int(os.environ.get("PORT", "8080"))
CACHE_TTL = int(os.environ.get("CACHE_TTL_SECONDS", "60"))
TIMEOUT   = float(os.environ.get("UPSTREAM_TIMEOUT_SECONDS", "20"))
RETRIES   = int(os.environ.get("UPSTREAM_RETRIES", "2"))
USER_AGENT = "Eve-Nexum scout relay (+https://github.com/GQuantrill/eve-nexum)"
ALLOWED_PREFIX = "/v2/public/signatures"

_lock: threading.Lock = threading.Lock()
_fresh: dict[str, tuple[float, bytes]] = {}   # path -> (expires_at, body)
_last_good: dict[str, bytes] = {}             # path -> last successful body


def log(msg: str) -> None:
    print(f"[relay] {msg}", flush=True)


def fetch_upstream(path: str) -> bytes:
    url = UPSTREAM + path
    last_error: Exception | None = None
    for attempt in range(1, RETRIES + 2):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                body = res.read()
            log(f"upstream {path} -> {len(body)} bytes in {time.monotonic() - t0:.2f}s (attempt {attempt})")
            return body
        except Exception as e:  # noqa: BLE001 - report every failure kind the same way
            last_error = e
            log(f"upstream {path} attempt {attempt} failed after {time.monotonic() - t0:.2f}s: {e!r}")
    assert last_error is not None
    raise last_error


def get(path: str) -> tuple[bytes, str]:
    now = time.monotonic()
    with _lock:
        hit = _fresh.get(path)
        if hit and hit[0] > now:
            return hit[1], "hit"
    try:
        body = fetch_upstream(path)
    except Exception:
        with _lock:
            stale = _last_good.get(path)
        if stale is not None:
            return stale, "stale"
        raise
    with _lock:
        _fresh[path] = (now + CACHE_TTL, body)
        _last_good[path] = body
    return body, "miss"


class Handler(BaseHTTPRequestHandler):
    server_version = "scout-relay/1.0"

    def log_message(self, *_args) -> None:  # keep the log to upstream events only
        pass

    def do_GET(self) -> None:
        if self.path in ("/", "/health"):
            self._send(200, b"ok", "text/plain")
            return
        if not self.path.startswith(ALLOWED_PREFIX):
            self._send(404, b"not found", "text/plain")
            return
        try:
            body, how = get(self.path)
        except Exception as e:  # noqa: BLE001
            payload = json.dumps({"error": "upstream unreachable", "detail": repr(e)}).encode()
            self._send(502, payload, "application/json")
            return
        self._send(200, body, "application/json; charset=utf-8", {"X-Relay-Cache": how})

    def _send(self, status: int, body: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", f"public, max-age={CACHE_TTL}")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    log(f"upstream={UPSTREAM} port={PORT} cache={CACHE_TTL}s timeout={TIMEOUT}s retries={RETRIES}")
    # Warm-up fetch: the boot log then states plainly whether this network can
    # reach eve-scout, without waiting for the first client.
    try:
        get(ALLOWED_PREFIX)
    except Exception as e:  # noqa: BLE001
        log(f"warm-up failed: {e!r}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
