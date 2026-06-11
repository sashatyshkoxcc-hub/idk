import asyncio
import importlib
import importlib.util
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import bcrypt
import httpx
import jwt
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).parent.parent
STATIC = Path(__file__).parent / "static"
USERS_DB = Path(__file__).parent / "users.json"
ACTIONS_LOG = Path(__file__).parent / "actions_log.json"
MESSAGE_LOGS_DB = ROOT / "message_logs.sqlite3"
MESSAGE_LOGS_JSON = ROOT / "message_logs.json"

logger = logging.getLogger(__name__)

_HAS_TOP_LEVEL_STORAGE = importlib.util.find_spec("storage") is not None
_HAS_BOT_STORAGE = importlib.util.find_spec("bot.storage.message_logs") is not None
_MSGLOG_MODULE = "storage.message_logs" if _HAS_TOP_LEVEL_STORAGE and importlib.util.find_spec("storage.message_logs") is not None else "bot.storage.message_logs" if _HAS_BOT_STORAGE else ""
msglog = importlib.import_module(_MSGLOG_MODULE) if _MSGLOG_MODULE else None

if msglog and hasattr(msglog, "configure_message_logs_paths"):
    msglog.configure_message_logs_paths(json_path=MESSAGE_LOGS_JSON, db_path=MESSAGE_LOGS_DB)

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
if not BOT_TOKEN and importlib.util.find_spec("bot.core.config") is not None:
    _cfg = importlib.import_module("bot.core.config")
    BOT_TOKEN = getattr(_cfg, "BOT_TOKEN", "") or ""

JWT_SECRET = os.environ.get("WEB_JWT_SECRET", "bot-dashboard-secret-2024")
if len(JWT_SECRET.encode("utf-8")) < 32:
    import hashlib

    JWT_SECRET = hashlib.sha256(JWT_SECRET.encode("utf-8")).hexdigest()
JWT_ALGO = "HS256"
TG_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

DEFAULT_LOGIN = os.environ.get("WEB_ADMIN_LOGIN", "Chelik")
DEFAULT_PASSWORD = os.environ.get("WEB_ADMIN_PASSWORD", "antiraid")
DEFAULT_NAME = os.environ.get("WEB_ADMIN_NAME", "Chelik")

DEFAULT_PROTECTIONS = {
    "antispam": {"enabled": True, "punishment": "мут", "duration": 30, "unit": "мин"},
    "antileak": {"enabled": False, "punishment": "мут", "duration": 30, "unit": "мин"},
    "antinsfw": {"enabled": False, "punishment": "мут", "duration": 30, "unit": "мин"},
    "anti_raid": {"enabled": False},
}

_SETTINGS_CACHE: dict = {"mtime": None, "data": {}}
_BOT_ID_CACHE: dict = {"id": None}
_BOT_INFO_CACHE: dict = {"id": None, "name": "", "username": "", "fetched_at": 0}
_BOT_INFO_TTL = 3600
_CHAT_AVAIL_CACHE: dict = {}
_CHAT_AVAIL_TTL = 600
_CHAT_RESP_CACHE: dict = {}
_ACTIONS_LOCK = asyncio.Lock()
_ACTIONS_MAX = 5000
_shared_http: Optional[httpx.AsyncClient] = None

app = FastAPI(docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=500)


async def _http() -> httpx.AsyncClient:
    global _shared_http
    if _shared_http is None:
        _shared_http = httpx.AsyncClient(timeout=10)
    return _shared_http


def _load_users() -> dict:
    if not USERS_DB.exists():
        return {}
    try:
        return json.loads(USERS_DB.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def _save_users(data: dict):
    tmp = USERS_DB.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, USERS_DB)


def _ensure_admin():
    users = _load_users()
    migrated = False
    for key in list(users.keys()):
        user = users[key]
        if "email" in user and "login" not in user:
            user["login"] = user.pop("email")
            migrated = True
        if "is_default" not in user:
            user["is_default"] = False
            migrated = True

    if "admin" in users and not users["admin"].get("is_default"):
        users.pop("admin", None)
        migrated = True

    if not any(user.get("is_default") for user in users.values()):
        users[DEFAULT_LOGIN] = {
            "login": DEFAULT_LOGIN,
            "name": DEFAULT_NAME,
            "password_hash": bcrypt.hashpw(DEFAULT_PASSWORD.encode(), bcrypt.gensalt()).decode(),
            "is_default": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        migrated = True
        logger.info("[WEB] Создан дефолтный пользователь: %s", DEFAULT_LOGIN)

    if migrated:
        _save_users(users)


def _make_token(login: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(hours=12)
    return jwt.encode({"sub": login, "exp": exp}, JWT_SECRET, algorithm=JWT_ALGO)


def _get_current_user(request: Request) -> dict:
    token = request.cookies.get("access_token")
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if not token:
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        user = _load_users().get(payload["sub"])
        if not user:
            raise HTTPException(401, "User not found")
        return {"login": user["login"], "name": user.get("name", user["login"]), "is_default": bool(user.get("is_default", False))}
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except Exception:
        raise HTTPException(401, "Invalid token")


def _require_default(user: dict) -> dict:
    if not user.get("is_default"):
        raise HTTPException(403, "Недостаточно прав")
    return user


def _read_actions() -> list:
    if not ACTIONS_LOG.exists():
        return []
    try:
        data = json.loads(ACTIONS_LOG.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _write_actions(items: list):
    tmp = ACTIONS_LOG.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, ACTIONS_LOG)


async def _log_action(user: Optional[dict], action: str, details: Optional[dict] = None, request: Optional[Request] = None):
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "login": (user or {}).get("login", "—"),
        "name": (user or {}).get("name", ""),
        "is_default": bool((user or {}).get("is_default", False)),
        "action": action,
        "details": details or {},
    }
    if request is not None:
        entry["ip"] = (request.client.host if request.client else "") or request.headers.get("x-forwarded-for", "")
        entry["path"] = str(request.url.path)
        entry["method"] = request.method
    async with _ACTIONS_LOCK:
        items = _read_actions()
        items.append(entry)
        _write_actions(items[-_ACTIONS_MAX:])


async def tg(method: str, **params) -> dict:
    if not BOT_TOKEN:
        return {"ok": False, "description": "BOT_TOKEN не задан"}
    client = await _http()
    try:
        response = await client.post(f"{TG_API}/{method}", json={key: val for key, val in params.items() if val is not None})
        return response.json()
    except Exception as exc:
        return {"ok": False, "description": str(exc)}


def _message_logs_version() -> int:
    versions = []
    if msglog and hasattr(msglog, "get_version"):
        versions.append(msglog.get_version())
    for path in (MESSAGE_LOGS_DB, Path(f"{MESSAGE_LOGS_DB}-wal"), Path(f"{MESSAGE_LOGS_DB}-shm")):
        try:
            versions.append(path.stat().st_mtime_ns)
        except OSError:
            pass
    return max(versions) if versions else int(time.time())


def _chat_messages(chat_id: str) -> list:
    if not msglog or not hasattr(msglog, "get_chat_messages"):
        return []
    try:
        return msglog.get_chat_messages(int(chat_id), getattr(msglog, "MAX_PER_CHAT", 500))
    except Exception:
        return []


def _message_logs() -> dict:
    if not msglog or not hasattr(msglog, "get_known_chats"):
        return {}
    data = {}
    for cid, title in msglog.get_known_chats():
        data[str(cid)] = {"title": title, "messages": _chat_messages(str(cid))}
    return data


def _append_to_message_log(chat_id: str, entry: dict, chat_title: str = ""):
    if not msglog or not hasattr(msglog, "log_message"):
        return
    try:
        msglog.log_message(int(chat_id), chat_title, entry)
        _CHAT_RESP_CACHE.pop(str(chat_id), None)
    except Exception as exc:
        logger.error("[WEB] Не смог дописать message_logs: %s", exc)


def _settings() -> dict:
    path = ROOT / "settings.json"
    if not path.exists():
        return {}
    try:
        mtime = path.stat().st_mtime
    except Exception:
        return _SETTINGS_CACHE["data"]
    if _SETTINGS_CACHE["mtime"] != mtime:
        try:
            _SETTINGS_CACHE["data"] = json.loads(path.read_text(encoding="utf-8"))
            _SETTINGS_CACHE["mtime"] = mtime
        except Exception as exc:
            logger.error("[WEB] settings read failed: %s", exc)
    return _SETTINGS_CACHE["data"]


async def _get_bot_info() -> dict:
    now = time.time()
    if _BOT_INFO_CACHE.get("id") and now - _BOT_INFO_CACHE.get("fetched_at", 0) < _BOT_INFO_TTL:
        return _BOT_INFO_CACHE
    result = await tg("getMe")
    if result.get("ok"):
        bot_data = result["result"]
        _BOT_INFO_CACHE.update({"id": bot_data["id"], "name": bot_data.get("first_name", "Bot"), "username": bot_data.get("username", ""), "fetched_at": now})
        _BOT_ID_CACHE["id"] = bot_data["id"]
    return _BOT_INFO_CACHE


async def _is_chat_available(chat_id: str) -> bool:
    now = time.time()
    cached = _CHAT_AVAIL_CACHE.get(chat_id)
    if cached and cached[1] > now:
        return cached[0]
    try:
        cid_int = int(chat_id)
    except Exception:
        _CHAT_AVAIL_CACHE[chat_id] = (False, now + 60)
        return False
    result = await tg("getChat", chat_id=cid_int)
    ok = bool(result.get("ok"))
    _CHAT_AVAIL_CACHE[chat_id] = (ok, now + (_CHAT_AVAIL_TTL if ok else 60))
    return ok


def _avatar_color(name: str) -> str:
    colors = ["#5288c1", "#e06d6d", "#6db38a", "#d4a756", "#9b6db3", "#d47b3f", "#5ba8a0"]
    return colors[sum(ord(char) for char in (name or "?")) % len(colors)]


class LoginBody(BaseModel):
    login: str
    password: str


class SendBody(BaseModel):
    text: str
    reply_to_message_id: Optional[int] = None


class ModerateBody(BaseModel):
    action: str
    user_id: int
    duration: Optional[int] = 1800


@app.post("/api/auth/login")
async def login(body: LoginBody, request: Request, response: Response):
    user = _load_users().get(body.login.strip())
    if not user or not bcrypt.checkpw(body.password.encode(), user["password_hash"].encode()):
        await _log_action({"login": body.login.strip(), "name": "", "is_default": False}, "login_failed", {"reason": "invalid credentials"}, request)
        raise HTTPException(401, "Неверный логин или пароль")
    token = _make_token(user["login"])
    response.set_cookie("access_token", token, httponly=True, samesite="lax", max_age=43200, path="/")
    payload = {"login": user["login"], "name": user.get("name", user["login"]), "is_default": bool(user.get("is_default", False))}
    await _log_action(payload, "login", {}, request)
    return payload


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    response.delete_cookie("access_token", path="/")
    await _log_action(None, "logout", {}, request)
    return {"ok": True}


@app.get("/api/auth/me")
async def me(user=Depends(_get_current_user)):
    return user


@app.get("/api/admin/logs")
async def get_logs(limit: int = 500, q: str = "", user=Depends(_get_current_user)):
    _require_default(user)
    items = _read_actions()
    if q:
        ql = q.lower()
        items = [item for item in items if ql in json.dumps(item, ensure_ascii=False).lower()]
    return list(reversed(items[-max(1, min(limit, 5000)):]))


@app.get("/api/bot/info")
async def bot_info(user=Depends(_get_current_user)):
    info = await _get_bot_info()
    return {"id": info.get("id"), "name": info.get("name") or "Bot", "username": info.get("username") or "", "photo": f"/api/photo/user/{info.get('id')}" if info.get("id") else None}


@app.get("/api/chats")
async def get_chats(user=Depends(_get_current_user)):
    logs = _message_logs()
    chat_ids = list(logs.keys())
    availability = await asyncio.gather(*[_is_chat_available(cid) for cid in chat_ids], return_exceptions=True) if chat_ids else []
    chats = []
    for cid, available in zip(chat_ids, availability):
        if available is not True:
            continue
        data = logs[cid]
        messages = data.get("messages", [])
        last_msg = messages[-1] if messages else None
        chats.append({"chat_id": cid, "title": data.get("title") or f"Chat {cid}", "message_count": len(messages), "last_message": last_msg, "last_date": last_msg.get("date") if last_msg else None, "color": _avatar_color(data.get("title", cid))})
    chats.sort(key=lambda item: item["last_date"] or "", reverse=True)
    return chats


@app.get("/api/chats/{chat_id}/messages")
async def get_messages(chat_id: str, user=Depends(_get_current_user)):
    messages = _chat_messages(chat_id)
    bot_id = _BOT_ID_CACHE.get("id")
    return [{**message, "is_bot": bot_id is not None and message.get("user_id") == bot_id} for message in messages]


@app.get("/api/chats/{chat_id}/stream")
async def stream_messages(chat_id: str, request: Request, user=Depends(_get_current_user)):
    async def gen():
        last_version = object()
        last_len = -1
        last_beat = time.time()
        while True:
            if await request.is_disconnected():
                return
            messages = _chat_messages(chat_id)
            version = _message_logs_version()
            if version != last_version or len(messages) != last_len:
                last_version = version
                last_len = len(messages)
                bot_id = _BOT_ID_CACHE.get("id")
                out = [{**message, "is_bot": bot_id is not None and message.get("user_id") == bot_id} for message in messages]
                yield f"data: {json.dumps(out, ensure_ascii=False)}\n\n"
                last_beat = time.time()
            elif time.time() - last_beat > 20:
                yield ": keep-alive\n\n"
                last_beat = time.time()
            await asyncio.sleep(0.2)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


@app.get("/api/chats/{chat_id}/members")
async def get_members(chat_id: str, user=Depends(_get_current_user)):
    seen = {}
    for message in _chat_messages(chat_id):
        uid = message.get("user_id")
        if not uid:
            continue
        seen.setdefault(uid, {"user_id": uid, "user_name": message.get("user_name", ""), "username": message.get("username", ""), "message_count": 0, "last_seen": message.get("date"), "color": _avatar_color(message.get("user_name", str(uid)))})
        seen[uid]["message_count"] += 1
        seen[uid]["last_seen"] = message.get("date")
    return sorted(seen.values(), key=lambda item: item["message_count"], reverse=True)


@app.get("/api/chats/{chat_id}/settings")
async def get_chat_settings(chat_id: str, user=Depends(_get_current_user)):
    saved = _settings().get(chat_id, {}) or {}
    result = {key: dict(value) for key, value in DEFAULT_PROTECTIONS.items()}
    for key, value in saved.items():
        result[key] = {**result[key], **value} if isinstance(value, dict) and key in result else value
    return result


@app.post("/api/chats/{chat_id}/send")
async def send_message(chat_id: str, body: SendBody, request: Request, user=Depends(_get_current_user)):
    if not body.text.strip():
        raise HTTPException(400, "Пустое сообщение")
    result = await tg("sendMessage", chat_id=int(chat_id), text=body.text, reply_to_message_id=body.reply_to_message_id)
    if not result.get("ok"):
        raise HTTPException(400, result.get("description", "Telegram error"))
    message = result["result"]
    out = {"message_id": message["message_id"], "date": datetime.fromtimestamp(message["date"], tz=timezone.utc).isoformat(), "user_id": message["from"]["id"], "user_name": message["from"].get("first_name", "Bot"), "username": message["from"].get("username", ""), "text": message.get("text", ""), "type": "text", "reply_to": body.reply_to_message_id, "is_bot": True}
    _append_to_message_log(chat_id, out, (message.get("chat") or {}).get("title", ""))
    await _log_action(user, "send_message", {"chat_id": chat_id, "message_id": out["message_id"], "text": body.text[:500]}, request)
    return {"ok": True, "message": out}


@app.post("/api/chats/{chat_id}/moderate")
async def moderate(chat_id: str, body: ModerateBody, request: Request, user=Depends(_get_current_user)):
    _require_default(user)
    cid = int(chat_id)
    if body.action == "ban":
        result = await tg("banChatMember", chat_id=cid, user_id=body.user_id)
    elif body.action == "unban":
        result = await tg("unbanChatMember", chat_id=cid, user_id=body.user_id, only_if_banned=True)
    elif body.action == "mute":
        until = int((datetime.now(timezone.utc) + timedelta(seconds=body.duration or 1800)).timestamp())
        result = await tg("restrictChatMember", chat_id=cid, user_id=body.user_id, permissions={"can_send_messages": False}, until_date=until)
    elif body.action == "unmute":
        result = await tg("restrictChatMember", chat_id=cid, user_id=body.user_id, permissions={"can_send_messages": True, "can_send_other_messages": True, "can_send_polls": True, "can_add_web_page_previews": True})
    else:
        raise HTTPException(400, "Unknown action")
    if not result.get("ok"):
        raise HTTPException(400, result.get("description", "Telegram error"))
    await _log_action(user, f"moderate_{body.action}", {"chat_id": chat_id, "user_id": body.user_id, "duration": body.duration}, request)
    return {"ok": True}


@app.post("/api/chats/{chat_id}/send_file")
async def send_file_msg(chat_id: str, request: Request, file: UploadFile = File(...), caption: str = Form(default=""), reply_to: Optional[int] = Form(default=None), user=Depends(_get_current_user)):
    content = await file.read()
    filename = file.filename or "file"
    content_type = file.content_type or "application/octet-stream"
    if content_type.startswith("image/gif") or filename.lower().endswith(".gif"):
        method, field = "sendAnimation", "animation"
    elif content_type.startswith("image/"):
        method, field = "sendPhoto", "photo"
    elif content_type.startswith("video/"):
        method, field = "sendVideo", "video"
    elif content_type.startswith("audio/"):
        method, field = "sendAudio", "audio"
    else:
        method, field = "sendDocument", "document"
    data = {"chat_id": str(int(chat_id))}
    if caption.strip():
        data["caption"] = caption.strip()
    if reply_to:
        data["reply_to_message_id"] = str(reply_to)
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(f"{TG_API}/{method}", data=data, files={field: (filename, content, content_type)})
    result = response.json()
    if not result.get("ok"):
        raise HTTPException(400, result.get("description", "Telegram error"))
    message = result["result"]
    media_value = message.get(field)
    if field == "photo" and isinstance(media_value, list):
        file_id = media_value[-1].get("file_id")
    elif isinstance(media_value, dict):
        file_id = media_value.get("file_id")
    else:
        file_id = None
    out = {"message_id": message["message_id"], "date": datetime.fromtimestamp(message["date"], tz=timezone.utc).isoformat(), "user_id": message.get("from", {}).get("id"), "user_name": message.get("from", {}).get("first_name", "Bot"), "username": message.get("from", {}).get("username", ""), "text": message.get("caption", "") or message.get("text", ""), "type": field, "file_id": file_id, "file_name": filename, "reply_to": reply_to, "is_bot": True}
    _append_to_message_log(chat_id, out, (message.get("chat") or {}).get("title", ""))
    await _log_action(user, "send_file", {"chat_id": chat_id, "type": field, "filename": filename, "size": len(content)}, request)
    return {"ok": True, "message": out}


@app.get("/api/file/{file_id:path}")
async def get_file(file_id: str, user=Depends(_get_current_user)):
    file_info = await tg("getFile", file_id=file_id)
    if not file_info.get("ok"):
        raise HTTPException(404, "No file")
    file_path = file_info["result"]["file_path"]
    client = await _http()
    response = await client.get(f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}")
    return Response(content=response.content, media_type=response.headers.get("content-type", "application/octet-stream"))


@app.get("/api/photo/user/{user_id}")
async def user_photo(user_id: int, user=Depends(_get_current_user)):
    result = await tg("getUserProfilePhotos", user_id=user_id, limit=1)
    if result.get("ok") and result["result"].get("total_count", 0) > 0:
        file_id = result["result"]["photos"][0][-1]["file_id"]
        return await get_file(file_id, user)
    raise HTTPException(404, "No photo")


@app.get("/api/photo/chat/{chat_id}")
async def chat_photo(chat_id: str, user=Depends(_get_current_user)):
    result = await tg("getChat", chat_id=int(chat_id))
    if result.get("ok") and result["result"].get("photo"):
        return await get_file(result["result"]["photo"]["small_file_id"], user)
    raise HTTPException(404, "No photo")


if (STATIC / "static").exists():
    app.mount("/static", StaticFiles(directory=str(STATIC / "static")), name="static_assets")


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    index = STATIC / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return Response("Bot Panel UI files not found", status_code=404)


async def start_web_server(host: str = "0.0.0.0", port: int = 8080):
    import uvicorn

    _ensure_admin()
    if msglog and hasattr(msglog, "load_message_logs"):
        msglog.load_message_logs()
    config = uvicorn.Config(app, host=host, port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    logger.info("[WEB] Дашборд запущен: http://%s:%s", host, port)
    await server.serve()
