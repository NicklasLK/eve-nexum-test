#!/usr/bin/env python3
"""Tiny relay for EvE-Scout's public Thera / Turnur feed.

Why: from some container networks the TLS handshake with api.eve-scout.com
(Azure Front Door, anycast) completes on some of its edge addresses and stalls
on others, so a single connection attempt fails most of the time. This relay
resolves every address, tries each in turn with a short timeout, keeps the feed
warm in the background, and serves the identical JSON to Nexum over plain HTTP
on the internal network. Standard library only.

    GET /                          -> "ok" (health check)
    GET /v2/public/signatures[?..] -> upstream JSON; the bare path is refreshed
                                      in the background every CACHE_TTL_SECONDS
                                      and served from memory; the last good copy
                                      is kept if upstream fails

Env: PORT (8080), UPSTREAM (https://api.eve-scout.com), CACHE_TTL_SECONDS (60),
UPSTREAM_TIMEOUT_SECONDS (6, per address), UPSTREAM_ROUNDS (2, passes over the
address list).
"""
from __future__ import annotations

import http.client
import json
import os
import socket
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

UPSTREAM   = os.environ.get("UPSTREAM", "https://api.eve-scout.com").rstrip("/")
PORT       = int(os.environ.get("PORT", "8080"))
CACHE_TTL  = int(os.environ.get("CACHE_TTL_SECONDS", "60"))
TIMEOUT    = float(os.environ.get("UPSTREAM_TIMEOUT_SECONDS", "6"))
ROUNDS     = int(os.environ.get("UPSTREAM_ROUNDS", "2"))
USER_AGENT = "Eve-Nexum scout relay (+https://github.com/GQuantrill/eve-nexum)"
ALLOWED_PREFIX = "/v2/public/signatures"

_up = urlparse(UPSTREAM)
UP_HOST = _up.hostname or "api.eve-scout.com"
UP_PORT = _up.port or (443 if _up.scheme == "https" else 80)
UP_TLS  = _up.scheme == "https"
_ssl_ctx = ssl.create_default_context()

_lock: threading.Lock = threading.Lock()
_fresh: dict[str, tuple[float, bytes]] = {}   # path -> (expires_at, body)
_last_good: dict[str, bytes] = {}             # path -> last successful body


def log(msg: str) -> None:
    print(f"[relay] {msg}", flush=True)


def resolve() -> list[tuple[int, tuple]]:
    """All (family, sockaddr) pairs for the upstream host, deduplicated, in
    resolver order. Re-resolved on every fetch so DNS rotation is honoured."""
    seen: set[str] = set()
    out: list[tuple[int, tuple]] = []
    for family, _type, _proto, _canon, sockaddr in socket.getaddrinfo(UP_HOST, UP_PORT, type=socket.SOCK_STREAM):
        if sockaddr[0] in seen:
            continue
        seen.add(sockaddr[0])
        out.append((family, sockaddr))
    return out


def fetch_via(family: int, sockaddr: tuple, path: str) -> bytes:
    """One attempt over one specific address: TCP connect, TLS with the real
    hostname for SNI and certificate checks, then a plain GET."""
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.settimeout(TIMEOUT)
    try:
        sock.connect(sockaddr)
        if UP_TLS:
            sock = _ssl_ctx.wrap_socket(sock, server_hostname=UP_HOST)
        conn = (http.client.HTTPSConnection(UP_HOST, UP_PORT, timeout=TIMEOUT) if UP_TLS
                else http.client.HTTPConnection(UP_HOST, UP_PORT, timeout=TIMEOUT))
        conn.sock = sock
        conn.request("GET", path, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        res = conn.getresponse()
        body = res.read()
        if res.status != 200:
            raise RuntimeError(f"upstream HTTP {res.status}")
        return body
    finally:
        try:
            sock.close()
        except OSError:
            pass


def fetch_upstream(path: str) -> bytes:
    addrs = resolve()
    last_error: Exception | None = None
    for rnd in range(1, ROUNDS + 1):
        for family, sockaddr in addrs:
            ip = sockaddr[0]
            t0 = time.monotonic()
            try:
                body = fetch_via(family, sockaddr, path)
                log(f"upstream {path} via {ip} -> {len(body)} bytes in {time.monotonic() - t0:.2f}s (round {rnd})")
                return body
            except Exception as e:  # noqa: BLE001 - every failure kind is reported the same way
                last_error = e
                log(f"upstream {path} via {ip} failed after {time.monotonic() - t0:.2f}s: {e!r}")
    raise last_error if last_error else RuntimeError("no upstream address")


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


def background_refresh() -> None:
    """Keep the bare feed warm so clients never wait on the upstream: refetch
    it every CACHE_TTL seconds, a little before the cached copy expires."""
    while True:
        try:
            with _lock:
                _fresh.pop(ALLOWED_PREFIX, None)   # force a real fetch
            get(ALLOWED_PREFIX)
        except Exception as e:  # noqa: BLE001
            log(f"background refresh failed: {e!r}")
        time.sleep(max(5, CACHE_TTL - 5))


class Handler(BaseHTTPRequestHandler):
    server_version = "scout-relay/1.1"

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
    log(f"upstream={UPSTREAM} port={PORT} cache={CACHE_TTL}s per-address timeout={TIMEOUT}s rounds={ROUNDS}")
    threading.Thread(target=background_refresh, name="refresh", daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
