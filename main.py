import asyncio
import logging
import os
import random
import re
import subprocess
import sys
from pathlib import Path
from pyrogram import Client as UserClient, filters, errors
from pyrogram.types import Message as UserMessage, Chat, User
from pyrogram.enums import ChatMemberStatus
from bottt import start_userbot
from bot.core.loader import bot, dp, ALLOWED_UPDATES
from bot.storage.state import load_settings
from bot.storage.message_logs import load_message_logs, save_message_logs
from bot.storage.blacklist_storage import load_blacklist
from bot.core.middlewares import MessageLoggerMiddleware, PrivacyGateMiddleware, message_logs_autosave_task
from bot.handlers.ai_analyze import router as ai_analyze_router
from bot.handlers.unified_handler import unified_router
from bot.handlers.anti_raid import router as anti_raid_router, anti_raid_middleware
from bot.handlers.commands import router as commands_router
from bot.handlers.new_members import router as new_members_router
from bot.handlers.personality import router as personality_router
from bot.handlers.group_text import router as group_text_router
from bot.handlers.history import router as history_router
from bot.handlers.logs import router as logs_router
from bot.handlers.private import router as private_router
from bot.handlers.antispam import router as antispam_router
from bot.handlers.anti_nsfw import router as anti_nsfw_router
#from bot.handlers.anti_leak import router as anti_leak_router
from bot.handlers.anti_link_leak import router as anti_link_leak_router
from bot.handlers.welcome_setup import router as welcome_router
from bot.handlers.dm_setup import router as dm_setup_router
from bot.handlers.referral import referral_router
from bot.handlers.privacy import router as privacy_router
from bot.handlers.subscription import router as subscription_router
from bot.handlers.extra_commands import router as extra_router
from bot.handlers.blacklist import router as blacklist_router
from bot.core.logging_setup import log_full
from web.server import start_web_server
from bot.handlers.media_ai import router as media_ai_router
from bot.handlers.media_react import router as media_react_router
from bot.handlers.auto_clean import router as auto_clean_router, AutoCleanMiddleware, start_auto_clean_task
from bot.handlers.admin_panel import router as admin_panel_router
from bot.handlers.anti_advertising import router as anti_advertising_router
from bot.handlers.anti_politics import router as anti_politics_router
from bot.handlers.anti_insults import router as anti_insults_router
from bot.handlers.moderation import router as moderation_router

logger = logging.getLogger(__name__)


def setup_routers():
    # === DM-SETUP ОБЯЗАТЕЛЬНО ПЕРВЫМ ===
    # Иначе /start setup_<chat_id> может быть перехвачен другими роутерами.
    dp.include_router(dm_setup_router)

    dp.include_router(auto_clean_router)
    dp.include_router(admin_panel_router)

    # === АНТИРЕЙД (для команд !антирейд) ===
    dp.include_router(anti_raid_router)

    dp.include_router(commands_router)
    # === ВАЖНО: new_members_router ДО privacy/welcome — иначе они «съедят»
    # событие my_chat_member первыми (см. raise SkipHandler в handle_bot_added)
    dp.include_router(new_members_router)
    dp.include_router(privacy_router)
    dp.include_router(subscription_router)
    dp.include_router(ai_analyze_router)
    dp.include_router(extra_router)
    dp.include_router(blacklist_router)
    dp.include_router(unified_router)
    dp.include_router(welcome_router)
    dp.include_router(group_text_router)
    dp.include_router(antispam_router)
    dp.include_router(anti_nsfw_router)
    #dp.include_router(anti_leak_router) #Удален
    dp.include_router(anti_link_leak_router)
    dp.include_router(anti_advertising_router)
    dp.include_router(anti_politics_router)
    dp.include_router(anti_insults_router)
    dp.include_router(personality_router)
    dp.include_router(referral_router)

    dp.include_router(media_react_router)

    dp.include_router(history_router)
    dp.include_router(logs_router)
    dp.include_router(moderation_router)
    dp.include_router(private_router)
    dp.include_router(media_ai_router)

    print("Роутеры настроены!")


def setup_middlewares():
    gate = PrivacyGateMiddleware()
    dp.message.outer_middleware(gate)
    dp.callback_query.outer_middleware(gate)

    dp.message.outer_middleware(MessageLoggerMiddleware())
    dp.message.outer_middleware(AutoCleanMiddleware())

    # === АНТИРЕЙД middleware (считает джойны, не съедая апдейт) ===
    dp.message.outer_middleware(anti_raid_middleware)
    dp.chat_member.outer_middleware(anti_raid_middleware)

    print("Middleware подключены!")


async def start_second_file():
    """Запускает bottt.py отдельным процессом через текущий Python."""
    process = await asyncio.create_subprocess_exec(sys.executable, "bottt.py")
    await process.wait()


def _ensure_allowed_updates(updates):
    required = ["message", "edited_message", "callback_query", "chat_member", "my_chat_member"]
    try:
        result = list(updates) if updates else []
    except Exception:
        result = []
    for u in required:
        if u not in result:
            result.append(u)
    return result


def _env_bool(name: str, default: bool = True) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off", "нет"}


def _env_port(*names: str, default: int) -> int:
    for name in names:
        raw = os.getenv(name)
        if not raw:
            continue
        try:
            port = int(raw)
        except ValueError:
            logger.warning("Некорректный %s=%r, использую порт %s", name, raw, default)
            return default
        if 1 <= port <= 65535:
            return port
        logger.warning("Порт из %s вне диапазона: %s, использую порт %s", name, raw, default)
        return default
    return default


def get_web_bind() -> tuple[str, int]:
    """
    Настройки запуска сайта для хостинга.

    На Render/Railway/Fly/других PaaS обычно порт приходит в переменной PORT.
    Для VPS можно явно указать WEB_HOST и WEB_PORT.
    """
    host = os.getenv("WEB_HOST", "0.0.0.0")
    port = _env_port("PORT", "WEB_PORT", default=24608)
    return host, port


async def start_hosting_site():
    """Запускает веб-панель так, чтобы она была доступна на хостинге."""
    if not _env_bool("WEB_ENABLED", True):
        logger.info("[WEB] Запуск сайта отключён через WEB_ENABLED=0")
        return

    host, port = get_web_bind()
    public_url = os.getenv("WEB_PUBLIC_URL", "").strip()
    if public_url:
        logger.info("[WEB] Публичный адрес панели: %s", public_url)
    logger.info("[WEB] Запускаю сайт на %s:%s", host, port)
    await start_web_server(host=host, port=port)


async def main():
    load_settings()
    load_message_logs()
    load_blacklist()
    setup_routers()
    setup_middlewares()

    asyncio.create_task(start_userbot())
    asyncio.create_task(start_second_file())

    from bot.handlers.anti_link_leak import periodic_leak_check
    asyncio.create_task(periodic_leak_check())
    asyncio.create_task(start_hosting_site())
    asyncio.create_task(message_logs_autosave_task(interval_seconds=15))
    asyncio.create_task(start_auto_clean_task())

    allowed = _ensure_allowed_updates(ALLOWED_UPDATES)
    print(f"Основной бот запущен! allowed_updates={allowed}")

    try:
        await dp.start_polling(bot, allowed_updates=allowed)
    finally:
        try:
            save_message_logs()
        except Exception:
            pass


if __name__ == "__main__":
    asyncio.run(main())
