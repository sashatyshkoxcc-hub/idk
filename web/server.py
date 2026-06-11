"""Small dependency-free web server for the Bot Panel static UI.

This module intentionally serves ``web/static/index.html`` for ``/``. If the
browser shows a plain text health-check response like ``+`` instead of the
panel, the process bound to the public port is not serving this file.
"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import posixpath
from email.utils import formatdate
from pathlib import Path
from urllib.parse import unquote, urlsplit

logger = logging.getLogger(__name__)

STATIC_ROOT = Path(__file__).resolve().parent / "static"
STATIC_ASSETS = STATIC_ROOT / "static"
INDEX_FILE = STATIC_ROOT / "index.html"

_TEXT_TYPES = {".html", ".css", ".js", ".json", ".svg", ".txt"}


def _response(
    status: str,
    body: bytes,
    *,
    content_type: str = "text/plain; charset=utf-8",
    headers: dict[str, str] | None = None,
) -> bytes:
    merged = {
        "Content-Type": content_type,
        "Content-Length": str(len(body)),
        "Date": formatdate(usegmt=True),
        "Connection": "close",
        "X-Content-Type-Options": "nosniff",
    }
    if headers:
        merged.update(headers)
    head = "\r\n".join([f"HTTP/1.1 {status}", *(f"{k}: {v}" for k, v in merged.items()), "", ""])
    return head.encode("utf-8") + body


def _json_response(status: str, payload: dict) -> bytes:
    return _response(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), content_type="application/json; charset=utf-8")


def _safe_asset_path(url_path: str) -> Path | None:
    rel = unquote(url_path.removeprefix("/static/")).lstrip("/")
    normalized = posixpath.normpath(rel)
    if normalized.startswith("../") or normalized == "..":
        return None
    candidate = (STATIC_ASSETS / normalized).resolve()
    try:
        candidate.relative_to(STATIC_ASSETS.resolve())
    except ValueError:
        return None
    return candidate


def _content_type(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    content_type = guessed or "application/octet-stream"
    if path.suffix.lower() in _TEXT_TYPES and "charset" not in content_type:
        content_type = f"{content_type}; charset=utf-8"
    return content_type


def _file_response(path: Path, *, cache: bool = False) -> bytes:
    if not path.is_file():
        return _response("404 Not Found", b"Not found")
    headers = {"Cache-Control": "public, max-age=3600" if cache else "no-store"}
    return _response("200 OK", path.read_bytes(), content_type=_content_type(path), headers=headers)


def _handle_request(method: str, target: str) -> bytes:
    path = urlsplit(target).path or "/"
    if method not in {"GET", "HEAD"}:
        return _json_response("405 Method Not Allowed", {"detail": "Method not allowed on static panel server"})

    if path in {"/health", "/healthz"}:
        return _json_response("200 OK", {"ok": True, "service": "bot-panel-static"})

    if path.startswith("/api/"):
        return _json_response(
            "503 Service Unavailable",
            {
                "detail": "Static panel is running, but API backend routes are not mounted on this server.",
                "hint": "Run the full FastAPI backend or proxy /api/* to it.",
            },
        )

    if path.startswith("/static/"):
        asset = _safe_asset_path(path)
        return _file_response(asset, cache=True) if asset else _response("403 Forbidden", b"Forbidden")

    # SPA/root fallback. This is the important part for hosting: '/' must return
    # the actual HTML file, not a health-check text like '+'.
    return _file_response(INDEX_FILE)


async def _client_connected(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        raw = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        writer.close()
        await writer.wait_closed()
        return

    request_line = raw.split(b"\r\n", 1)[0].decode("iso-8859-1", errors="replace")
    parts = request_line.split()
    if len(parts) < 2:
        response = _response("400 Bad Request", b"Bad request")
    else:
        method, target = parts[0].upper(), parts[1]
        response = _handle_request(method, target)
        if method == "HEAD":
            response = response.split(b"\r\n\r\n", 1)[0] + b"\r\n\r\n"

    writer.write(response)
    await writer.drain()
    writer.close()
    await writer.wait_closed()


async def start_web_server(host: str = "0.0.0.0", port: int = 24608) -> None:
    """Start the panel web server and keep it running forever."""
    if not INDEX_FILE.is_file():
        raise FileNotFoundError(f"Panel index.html not found: {INDEX_FILE}")
    server = await asyncio.start_server(_client_connected, host, port)
    sockets = ", ".join(str(sock.getsockname()) for sock in server.sockets or [])
    logger.info("[WEB] Bot Panel static UI is serving %s from %s", sockets, INDEX_FILE)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(start_web_server())
