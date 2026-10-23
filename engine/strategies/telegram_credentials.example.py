"""Telegram credentials for this strategy's buy/sell alerts.

Copy this file into the strategy's folder as telegram_credentials.py, i.e.
    engine/strategies/<name>/telegram_credentials.py
and fill in the two values below. It is git-ignored there, so the token is
never committed. engine/core/credentials.py reads it (edits apply without a
restart); check it with:  python engine/quant.py notify test
"""

# From @BotFather in Telegram: send /newbot, then copy the token it gives you,
# e.g. "123456789:AAHkQ3...".
BOT_TOKEN = ""

# The chat the alerts go to: a private chat or a group. For a group, add the
# bot to the group (as admin if only admins may post); for a private chat, send
# the bot any message. Then run
#     python engine/quant.py notify chatid
# and paste the number it prints. Group ids are negative: keep the minus sign,
# e.g. "-1001234567890".
CHAT_ID = ""

# False pauses the alerts without deleting the credentials.
ENABLED = True
