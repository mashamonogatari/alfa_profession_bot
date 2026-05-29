import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qsl

from aiogram import Bot, Dispatcher, F
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import CommandStart
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)
from aiohttp import web
from dotenv import load_dotenv

from storage import AsyncLeadStore, LeadStore

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("alfa.main")

# ---------- config ----------

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
WEBAPP_URL = os.environ.get("WEBAPP_URL", "").strip()

# Persistent storage:
#   - bothost mounts a persistent volume at $DATA_DIR (e.g. /app/data)
#   - on a plain VPS we fall back to ./leads.db next to main.py
_DATA_DIR = os.environ.get("DATA_DIR", "").strip()
DB_PATH = os.environ.get("DB_PATH") or (
    os.path.join(_DATA_DIR, "leads.db") if _DATA_DIR else "./leads.db"
)

HTTP_HOST = os.environ.get("HTTP_HOST", "0.0.0.0")
# Many PaaS (bothost / Railway / Render / Heroku) inject the bind port as $PORT
HTTP_PORT = int(os.environ.get("PORT", os.environ.get("HTTP_PORT", "8080")))

ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

# Where the static webapp/ lives, relative to this file by default.
WEBAPP_DIR = os.environ.get(
    "WEBAPP_DIR",
    os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "webapp")),
)

# ---------- rate limit ----------

RATE_WINDOW_SEC = 60
RATE_LIMIT = 10
_rate_hits: Dict[str, "deque[float]"] = defaultdict(deque)


def rate_limited(ip: str) -> bool:
    now = time.time()
    dq = _rate_hits[ip]
    while dq and now - dq[0] > RATE_WINDOW_SEC:
        dq.popleft()
    if len(dq) >= RATE_LIMIT:
        return True
    dq.append(now)
    return False


# ---------- TG initData validation ----------

PHONE_RE = re.compile(r"^[\d\s\-\+\(\)]{10,20}$")
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")


def validate_init_data(init_data: str, bot_token: str) -> Optional[Dict[str, Any]]:
    """Verify Telegram WebApp initData HMAC. Returns parsed dict or None."""
    if not init_data:
        return None
    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
        received_hash = pairs.pop("hash", None)
        if not received_hash:
            return None
        data_check = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
        secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
        expected = hmac.new(secret, data_check.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, received_hash):
            return None
        if "user" in pairs:
            try:
                pairs["user"] = json.loads(pairs["user"])
            except Exception:
                pass
        return pairs
    except Exception:
        return None


# ---------- HTTP handlers ----------

def cors_headers(origin: Optional[str]) -> Dict[str, str]:
    if ALLOWED_ORIGINS == ["*"]:
        allow = origin or "*"
    elif origin and origin in ALLOWED_ORIGINS:
        allow = origin
    else:
        allow = ALLOWED_ORIGINS[0] if ALLOWED_ORIGINS else ""
    return {
        "Access-Control-Allow-Origin": allow,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
    }


async def options_lead(request: web.Request) -> web.Response:
    return web.Response(status=204, headers=cors_headers(request.headers.get("Origin")))


async def health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


def _norm_contact(contact_type: str, value: str) -> Tuple[bool, str]:
    value = (value or "").strip()
    if contact_type == "email":
        return bool(EMAIL_RE.match(value)), value
    if contact_type == "phone":
        if not PHONE_RE.match(value):
            return False, value
        digits = re.sub(r"\D", "", value)
        if len(digits) < 10:
            return False, value
        return True, value
    return False, value


def _ranking_to_columns(ranking) -> Dict[str, str]:
    out = {"top_profession_id": "", "top_percent": "",
           "second_id": "", "second_percent": "",
           "third_id": "", "third_percent": "",
           "fourth_id": "", "fourth_percent": ""}
    keys = [("top_profession_id", "top_percent"),
            ("second_id", "second_percent"),
            ("third_id", "third_percent"),
            ("fourth_id", "fourth_percent")]
    for i, (k_id, k_pct) in enumerate(keys):
        if i < len(ranking) and isinstance(ranking[i], dict):
            out[k_id] = str(ranking[i].get("id", ""))
            out[k_pct] = str(ranking[i].get("percent", ""))
    return out


async def post_lead(request: web.Request) -> web.Response:
    origin = request.headers.get("Origin")
    headers = cors_headers(origin)
    ip = request.headers.get("X-Forwarded-For", request.remote or "").split(",")[0].strip() or "?"

    if rate_limited(ip):
        return web.json_response({"ok": False, "error": "rate_limited"}, status=429, headers=headers)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad_json"}, status=400, headers=headers)

    name = (body.get("name") or "").strip()
    contact_type = body.get("contact_type")
    contact_value = body.get("contact_value")
    consent = bool(body.get("consent"))
    source = body.get("source") or "kiosk"
    tg_init_data = body.get("tg_init_data") or ""
    result = body.get("result") or {}
    ranking = result.get("ranking") or []
    user_agent = (body.get("user_agent") or request.headers.get("User-Agent") or "")[:300]

    if not name or len(name) > 100:
        return web.json_response({"ok": False, "error": "bad_name"}, status=400, headers=headers)
    if contact_type not in ("phone", "email"):
        return web.json_response({"ok": False, "error": "bad_contact_type"}, status=400, headers=headers)
    ok, contact_value = _norm_contact(contact_type, contact_value or "")
    if not ok:
        return web.json_response({"ok": False, "error": "bad_contact"}, status=400, headers=headers)
    if not consent:
        return web.json_response({"ok": False, "error": "no_consent"}, status=400, headers=headers)

    tg_user_id = ""
    tg_username = ""
    if tg_init_data:
        parsed = validate_init_data(tg_init_data, TELEGRAM_BOT_TOKEN)
        if parsed and isinstance(parsed.get("user"), dict):
            tg_user_id = str(parsed["user"].get("id") or "")
            tg_username = str(parsed["user"].get("username") or "")
            source = "telegram"

    cols = _ranking_to_columns(ranking)
    row = [
        datetime.now(timezone.utc).isoformat(timespec="seconds"),
        name,
        contact_type,
        contact_value,
        cols["top_profession_id"], cols["top_percent"],
        cols["second_id"], cols["second_percent"],
        cols["third_id"], cols["third_percent"],
        cols["fourth_id"], cols["fourth_percent"],
        source,
        tg_user_id,
        tg_username,
        user_agent,
        "yes" if consent else "no",
    ]

    store: AsyncLeadStore = request.app["store"]
    try:
        await store.append_row(row)
    except Exception as e:
        log.exception("db write failed: %s", e)
        return web.json_response({"ok": False, "error": "storage"}, status=500, headers=headers)

    log.info("lead saved: %s / %s / top=%s",
             name[:30], contact_type, cols["top_profession_id"])
    return web.json_response({"ok": True}, headers=headers)


# ---------- Telegram bot ----------

def build_dispatcher() -> Dispatcher:
    dp = Dispatcher()

    @dp.message(CommandStart())
    async def on_start(message: Message) -> None:
        kb = InlineKeyboardMarkup(
            inline_keyboard=[[
                InlineKeyboardButton(
                    text="Пройти тест",
                    web_app=WebAppInfo(url=WEBAPP_URL),
                )
            ]]
        )
        await message.answer(
            "Привет! Это короткий тест от Альфа-Будущего — узнай, кем ты будешь в финтехе. "
            "Жми кнопку ниже и поехали.",
            reply_markup=kb,
        )

    @dp.message(F.text)
    async def fallback(message: Message) -> None:
        await on_start(message)

    return dp


# ---------- entrypoint ----------

async def index_html(request: web.Request) -> web.Response:
    index = os.path.join(WEBAPP_DIR, "index.html")
    if not os.path.exists(index):
        return web.Response(status=404, text="webapp index.html not found")
    return web.FileResponse(index, headers={"Cache-Control": "no-cache, must-revalidate"})


async def main() -> None:
    store = AsyncLeadStore(LeadStore(DB_PATH))

    app = web.Application()
    app["store"] = store
    # API routes first (priority over static catch-all)
    app.router.add_post("/api/lead", post_lead)
    app.router.add_options("/api/lead", options_lead)
    app.router.add_get("/healthz", health)
    # Webapp static files (index.html on /, then all assets)
    if os.path.isdir(WEBAPP_DIR):
        app.router.add_get("/", index_html)
        app.router.add_static("/", WEBAPP_DIR, show_index=False)
        log.info("Serving webapp from %s", WEBAPP_DIR)
    else:
        log.warning("WEBAPP_DIR not found (%s) — API-only mode", WEBAPP_DIR)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, HTTP_HOST, HTTP_PORT)
    await site.start()
    log.info("HTTP server listening on %s:%s", HTTP_HOST, HTTP_PORT)
    log.info("SQLite DB: %s", DB_PATH)
    log.info("Allowed origins: %s", ALLOWED_ORIGINS)

    if not TELEGRAM_BOT_TOKEN:
        log.warning("TELEGRAM_BOT_TOKEN is empty — running API only, no bot.")
        try:
            await asyncio.Event().wait()
        finally:
            await runner.cleanup()
        return

    if not WEBAPP_URL:
        log.warning("WEBAPP_URL is empty — bot will start, but /start button will fail.")

    log.info("WebApp URL: %s", WEBAPP_URL)
    bot = Bot(token=TELEGRAM_BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = build_dispatcher()
    try:
        await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())
    finally:
        await runner.cleanup()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
