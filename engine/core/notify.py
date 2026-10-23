"""Telegram buy/sell alerts for the live signal (any strategy).

Posts a message whenever the live signal's POSITION changes (flat -> long is a
BUY, long -> flat a SELL, etc.). Called from core.live with the live signal,
which is computed off the latest traded price.

Credentials (never committed): the bot token and chat id live in the
strategy's own folder, engine/strategies/<name>/telegram_credentials.py — see
core/credentials.py. `quant.py notify test` sends a test message and says what
is wrong if it can't; the app's Log tab shows the same status when the live
signal starts, and every alert sent or failed.

Fails soft: missing config or a network error is logged and swallowed so it
can never break the live-signal computation. CLI: `quant.py notify`.
"""
from __future__ import annotations

import os
import json
import time
import logging
import threading
import urllib.error
import urllib.parse
import urllib.request

from . import credentials

logger = logging.getLogger("notify")

# After a failed send, wait this long before trying again (the live signal
# recomputes on every trade; retrying each time would hammer a dead link).
RETRY_SECONDS = 30
# A new live position must hold this long before it is alerted, so a forming
# bar that wobbles across a threshold doesn't send a BUY/SELL on every flip.
HOLD_SECONDS = 120

# position -> (emoji, headline) shown when it BECOMES that position from flat.
_OPEN = {
    1:  ("\U0001F7E2", "BUY — OPEN LONG"),          # 🟢
    -1: ("\U0001F534", "SELL SHORT — OPEN SHORT"),  # 🔴
}
_CLOSE = {
    1:  ("⚪", "SELL — CLOSE LONG"),          # ⚪ (was long)
    -1: ("⚪", "BUY TO COVER — CLOSE SHORT"),  # ⚪ (was short)
}


def config_status(strat) -> str:
    """One line saying whether alerts will go out, and if not, why."""
    c = credentials.load(strat)
    if c.problem:
        return f"not configured: {c.problem}"
    if not c.enabled:
        return f"disabled (ENABLED = False in {c.where})"
    if not c.token or not c.chat_id:
        missing = " and ".join(n for n, v in (("BOT_TOKEN", c.token), ("CHAT_ID", c.chat_id)) if not v)
        return f"not configured: no {missing} (set it in {c.where})"
    return f"on (chat {c.chat_id})"


def is_configured(strat) -> bool:
    return credentials.load(strat).ready


def send_message(text: str, strat):
    """Post a plain-text message. Returns (ok: bool, info: str)."""
    c = credentials.load(strat)
    if not c.enabled:
        return False, "disabled"
    if not c.token or not c.chat_id:
        return False, "not configured"
    token, chat = c.token, c.chat_id
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": chat,
        "text": text,
        "disable_web_page_preview": "true",
    }).encode()
    try:
        req = urllib.request.Request(url, data=data)
        with urllib.request.urlopen(req, timeout=10) as resp:
            ok = 200 <= resp.status < 300
            return ok, "sent" if ok else f"http {resp.status}"
    except urllib.error.HTTPError as e:   # Telegram explains itself in the body
        info = _http_error(e)
        logger.warning("Telegram send failed: %s", info)
        return False, info
    except Exception as e:  # network / proxy / TLS
        logger.warning("Telegram send failed: %s", e)
        return False, str(e)


def _http_error(e) -> str:
    """Telegram's own reason for a failed call, plus what to do about it."""
    try:
        body = json.loads(e.read().decode())
    except Exception:
        body = {}
    info = f"HTTP {e.code}: {body.get('description') or e.reason}"
    # A group that became a supergroup (e.g. when made public or given admins)
    # gets a new id; Telegram says which.
    new_id = (body.get("parameters") or {}).get("migrate_to_chat_id")
    if new_id:
        info += f" — the group was upgraded: set CHAT_ID = \"{new_id}\""
    elif e.code == 401:
        info += " — the bot token is wrong"
    return info


def _read_state(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {}


def _write_state(path, state):
    try:
        os.makedirs(path.parent, exist_ok=True)
        path.write_text(json.dumps(state), encoding="utf-8")
    except OSError as e:
        logger.warning("Could not write alert state: %s", e)


def format_alert(prev: int, pos: int, payload: dict, symbol: str, when: str = "") -> str:
    mkt = payload.get("market", {})
    price = mkt.get("price")
    price_txt = f"${price:,.2f}" if isinstance(price, (int, float)) else "—"
    source = mkt.get("source") or ""

    if prev == 0:                       # opening a fresh position
        emoji, head = _OPEN[pos]
    elif pos == 0:                      # closing to flat
        emoji, head = _CLOSE[prev]
    elif pos == -1:                     # direct flip long -> short
        emoji, head = "\U0001F501", "FLIP — CLOSE LONG then SELL SHORT"
    else:                               # direct flip short -> long
        emoji, head = "\U0001F501", "FLIP — CLOSE SHORT then BUY LONG"

    lines = [f"{emoji} {head} — {symbol}"]
    lines.append(f"Price {price_txt}" + (f" ({source})" if source else ""))
    if when:
        lines.append(when)
    return "\n".join(lines)


def now_local(strat) -> str:
    """'YYYY-MM-DD HH:MM <tz label>' in the strategy's timezone (for pings)."""
    import datetime
    import zoneinfo
    now = datetime.datetime.now(zoneinfo.ZoneInfo(strat.tz)).strftime("%Y-%m-%d %H:%M")
    return f"{now} {strat.manifest.get('timezone_label', strat.tz)}"


# Update kinds that carry a chat. my_chat_member (the bot added to a group) and
# the group's service messages arrive even with the bot's group privacy on,
# when ordinary group messages don't.
_CHAT_UPDATES = ("message", "edited_message", "channel_post", "edited_channel_post",
                 "my_chat_member", "chat_member", "chat_join_request")


def print_chat_ids(strat):
    """Print the chats the bot has seen (private chats, groups it was added
    to, channels), to fill in CHAT_ID."""
    c = credentials.load(strat)
    token = c.token
    if not token:
        print(f"No bot token: set BOT_TOKEN in {c.where} first.")
        if c.problem:
            print(c.problem)
        return
    try:
        url = f"https://api.telegram.org/bot{token}/getUpdates"
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print("getUpdates failed:", _http_error(e))
        return
    except Exception as e:
        print("getUpdates failed:", e)
        return
    seen, upgraded = {}, {}
    for upd in data.get("result", []):
        for kind in _CHAT_UPDATES:
            item = upd.get(kind)
            if not item or not (item.get("chat") or {}).get("id"):
                continue
            chat = item["chat"]
            name = chat.get("title") or chat.get("username") or chat.get("first_name") or ""
            seen[chat["id"]] = (chat.get("type", "?"), name)
            if item.get("migrate_to_chat_id"):
                upgraded[chat["id"]] = item["migrate_to_chat_id"]
    if not seen:
        print("No chats found. Send your bot a message, or (for a group) add the bot")
        print("to the group — or remove and re-add it — then re-run within a day.")
        return
    for cid, (kind, name) in seen.items():
        if cid in upgraded:   # replaced by its supergroup id
            if upgraded[cid] not in seen:
                print(f"chat_id: {upgraded[cid]}   supergroup {name} (upgraded from {cid})")
            continue
        print(f"chat_id: {cid}   {kind:<10} {name}")
    if any(k in ("group", "supergroup") for k, _ in seen.values()):
        print("Groups have negative ids: copy the minus sign too.")


def _decide(payload: dict, strat):
    """What the Alerter should do with this payload: (prev, pos) when
    the position changed since the last alert, else (None, reason)."""
    try:
        pos = int(payload["signal"]["position"])
    except (KeyError, TypeError, ValueError):
        return None, "no position in payload"
    state = _read_state(strat.alert_state_json)
    prev = state.get("position")
    if prev is None:
        # First run: record the current position WITHOUT sending, so you don't
        # get a spurious ping for a position that was already open.
        _write_state(strat.alert_state_json,
                     {"position": pos, "ts": payload.get("market", {}).get("ts")})
        return None, "initialized (no alert)"
    if pos == int(prev):
        return None, "no change"
    return (int(prev), pos), ""


def _send_alert(change, payload, strat):
    prev, pos = change
    sent, info = send_message(format_alert(prev, pos, payload, strat.symbol, now_local(strat)), strat)
    # Advance the state only on a successful send, so a failure retries instead
    # of silently missing the alert.
    if sent:
        _write_state(strat.alert_state_json,
                     {"position": pos, "ts": payload.get("market", {}).get("ts")})
    return sent, info


class _SenderLock:
    """An OS file lock in the strategy's data folder held by the one live
    watcher that sends alerts, so a second watcher (a second copy of the app,
    or one left running after a crash) never sends every alert twice. The OS
    frees it when the holder exits."""

    def __init__(self, path):
        self.path = path
        self._fh = None

    def acquire(self) -> bool:
        if self._fh is not None:
            return True
        try:
            os.makedirs(self.path.parent, exist_ok=True)
            fh = open(self.path, "a+")
        except OSError:
            return True   # can't lock (read-only folder?): don't block alerts
        try:
            if os.name == "nt":
                import msvcrt
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            return False
        self._fh = fh
        return True


class Alerter:
    """Telegram alerts for the watch loop. A new position is alerted only once
    it has held for HOLD_SECONDS (any flip in between restarts the clock;
    flipping back to the alerted position cancels it), so call it regularly,
    not just on new prices. The send runs on a background thread so a slow or
    unreachable Telegram never holds up the live signal, and after a failure it
    waits RETRY_SECONDS before trying again. Only one watcher per strategy
    sends (see _SenderLock); another stays quiet until that one exits."""

    def __init__(self, strat, log=print, hold_seconds=None):
        self.strat = strat
        self.log = log
        self.hold = HOLD_SECONDS if hold_seconds is None else hold_seconds
        self._busy = False
        self._retry_at = 0.0
        self._pending = None    # (position, since) waiting out the hold
        self._lock = threading.Lock()
        self._sender = _SenderLock(strat.data_dir / "live_alerts.lock")
        self._standby = False   # logged that another watcher is sending

    def reset(self) -> None:
        """Forget a position waiting out its hold (e.g. the feed went stale)."""
        with self._lock:
            self._pending = None

    def __call__(self, payload: dict) -> None:
        with self._lock:
            if not is_configured(self.strat):
                return
            if not self._sender.acquire():
                if not self._standby:
                    self._standby = True
                    self.log("telegram alerts: another live watcher is sending them; this one stays quiet")
                return
            if self._standby:
                self._standby = False
                self.log("telegram alerts: this live watcher now sends them")
            change, _why = _decide(payload, self.strat)
            if change is None:
                if self._pending is not None:
                    self.log(f"telegram alert cancelled: position {self._pending[0]:+d} "
                             f"reverted within {self.hold}s")
                self._pending = None
                return
            now = time.time()
            if self._pending is None or self._pending[0] != change[1]:
                self._pending = (change[1], now)
                if self.hold > 0:
                    self.log(f"telegram alert pending: position {change[0]:+d} -> {change[1]:+d}, "
                             f"sends if it holds {self.hold}s")
            if (now - self._pending[1] < self.hold or self._busy
                    or now < self._retry_at):
                return
            self._busy = True
        threading.Thread(target=self._run, args=(change, payload), daemon=True).start()

    def _run(self, change, payload):
        try:
            sent, info = _send_alert(change, payload, self.strat)
        except Exception as e:  # pragma: no cover - defensive
            sent, info = False, repr(e)
        with self._lock:
            self._busy = False
            self._retry_at = 0.0 if sent else time.time() + RETRY_SECONDS
            if sent:
                self._pending = None
        prev, pos = change
        if sent:
            self.log(f"telegram alert sent: position {prev:+d} -> {pos:+d}")
        else:
            self.log(f"telegram alert FAILED ({info}); retrying in {RETRY_SECONDS}s")
