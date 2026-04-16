#!/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13
"""
Echo Karaoke — Telegram alert bot.
Polls device_status table every 60s.
Sends Telegram alert if any device heartbeat is stale >3 minutes.
"""
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# --- Env loading (same pattern as karaoke_yandex.py) ---
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for line in _env_path.read_text().split('\n'):
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

from supabase import create_client
import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://anlhvcspsuxpaibnvrxr.supabase.co")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]

STALE_THRESHOLD_MIN = 3
POLL_INTERVAL_SEC = 60

ROOM_NAMES = {
    'hall_1': 'Зал 1', 'hall_2': 'Зал 2', 'hall_3': 'Зал 3',
    'hall_4': 'Зал 4', 'hall_5': 'Зал 5',
}

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# Track alerted rooms to avoid spam
alerted_rooms = set()


def send_telegram(text):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    try:
        resp = requests.post(url, json={
            "chat_id": TELEGRAM_CHAT_ID,
            "text": text,
            "parse_mode": "HTML",
        }, timeout=10)
        if not resp.ok:
            print(f"Telegram error: {resp.status_code} {resp.text}", file=sys.stderr)
    except Exception as e:
        print(f"Telegram send failed: {e}", file=sys.stderr)


def check_devices():
    result = sb.table("device_status").select("*").execute()
    devices = result.data or []
    now = datetime.now(timezone.utc)

    for d in devices:
        room_id = d["room_id"]
        updated_at = datetime.fromisoformat(d["updated_at"].replace("Z", "+00:00"))
        age_min = (now - updated_at).total_seconds() / 60
        room_name = ROOM_NAMES.get(room_id, room_id)

        if age_min > STALE_THRESHOLD_MIN:
            if room_id not in alerted_rooms:
                state = d.get("state", "?")
                last_error = d.get("last_error") or "нет"
                text = (
                    f"<b>{room_name}</b> offline уже {int(age_min)} мин.\n"
                    f"Последнее состояние: {state}\n"
                    f"Последняя ошибка: {last_error}"
                )
                send_telegram(text)
                alerted_rooms.add(room_id)
                print(f"ALERT: {room_name} stale {int(age_min)}min")
        else:
            if room_id in alerted_rooms:
                send_telegram(f"<b>{room_name}</b> снова online.")
                alerted_rooms.discard(room_id)
                print(f"RECOVERED: {room_name}")


def main():
    print(f"Echo alert bot started. Polling every {POLL_INTERVAL_SEC}s, threshold {STALE_THRESHOLD_MIN}min.")
    while True:
        try:
            check_devices()
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    main()
