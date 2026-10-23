"""Telegram credentials: the bot token and chat id the alerts are sent with.

They live with the strategy, in its own folder:

    engine/strategies/<name>/telegram_credentials.py
        BOT_TOKEN = "123456789:AA..."
        CHAT_ID = "123456789"
        ENABLED = True

(start from engine/strategies/telegram_credentials.example.py; the file is
git-ignored so the token is never committed). Each value is taken from the
first of these that sets it:

    1. environment variables TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
    2. the strategy's telegram_credentials.py
    3. engine/telegram_config.json  (the older location, still honoured)

The file is re-read when it changes, so edits apply without a restart.
"""
from __future__ import annotations

import os
import json
import importlib.util
from dataclasses import dataclass

from . import paths

FILENAME = "telegram_credentials.py"

_cache: dict = {}   # path -> (mtime, values, problem)


@dataclass
class Credentials:
    token: "str | None"
    chat_id: "str | None"
    enabled: bool
    problem: "str | None"   # why a credentials file couldn't be read, if one couldn't
    where: str              # the strategy's credentials file (for messages)

    @property
    def ready(self) -> bool:
        return bool(self.enabled and self.token and self.chat_id)


def path(strat):
    return strat.folder / FILENAME


def _read_strategy_file(p):
    """({BOT_TOKEN, CHAT_ID, ENABLED} as set, problem or None) from the
    strategy's telegram_credentials.py; empty when there is no file."""
    try:
        mtime = os.stat(p).st_mtime_ns
    except OSError:
        return {}, None
    hit = _cache.get(p)
    if hit and hit[0] == mtime:
        return hit[1], hit[2]
    values, problem = {}, None
    try:
        spec = importlib.util.spec_from_file_location(f"_telegram_credentials_{abs(hash(str(p)))}", p)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        values = {k: getattr(mod, k) for k in ("BOT_TOKEN", "CHAT_ID", "ENABLED") if hasattr(mod, k)}
    except Exception as e:   # a typo in the file: say so rather than go quiet
        problem = f"{p.name} could not be loaded ({type(e).__name__}: {e})"
    _cache[p] = (mtime, values, problem)
    return values, problem


def _read_legacy_file():
    """engine/telegram_config.json, the older location (JSON)."""
    try:
        # utf-8-sig: Notepad and PowerShell often save JSON with a BOM.
        cfg = json.loads(paths.TELEGRAM_CONFIG.read_text(encoding="utf-8-sig"))
        return {"BOT_TOKEN": cfg.get("bot_token"), "CHAT_ID": cfg.get("chat_id"),
                "ENABLED": cfg.get("enabled", True)}, None
    except FileNotFoundError:
        return {}, None
    except UnicodeDecodeError:
        return {}, (f"{paths.TELEGRAM_CONFIG.name} is not UTF-8 (save it as UTF-8; "
                    "PowerShell's '>' writes UTF-16)")
    except ValueError as e:
        return {}, f"{paths.TELEGRAM_CONFIG.name} is not valid JSON ({e})"


def _text(v):
    """A usable credential string, or None (blank or an untouched placeholder)."""
    if v is None:
        return None
    v = str(v).strip()
    return None if not v or "PASTE" in v else v


def _enabled(v) -> bool:
    if isinstance(v, str):
        return v.strip().lower() not in ("false", "no", "off", "0", "")
    return bool(v)


def load(strat) -> Credentials:
    own, own_problem = _read_strategy_file(path(strat))
    old, old_problem = _read_legacy_file()

    def pick(env, key):
        for v in (os.environ.get(env), own.get(key), old.get(key)):
            if _text(v):
                return _text(v)
        return None

    enabled = own.get("ENABLED", old.get("ENABLED", True))
    return Credentials(
        token=pick("TELEGRAM_BOT_TOKEN", "BOT_TOKEN"),
        chat_id=pick("TELEGRAM_CHAT_ID", "CHAT_ID"),
        enabled=_enabled(enabled),
        problem=own_problem or old_problem,
        where=str(path(strat)),
    )
