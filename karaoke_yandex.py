#!/usr/bin/env python3
"""
Караоке-конвейер v3: Яндекс Музыка
Поиск по названию → скачивание 320kbps → Demucs → LRC тексты + Whisper word-level → Supabase

Преимущества над YouTube-пайплайном:
- Аудио 320 kbps (vs 128-192 у YouTube)
- LRC тексты с построчными таймингами (vs Genius plain text)
- Точный поиск по базе Яндекс Музыки

Использование:
  python3 karaoke_yandex.py "Кино - Группа крови" "Руки Вверх - Крошка моя"
  python3 karaoke_yandex.py --album 12345          # весь альбом
  python3 karaoke_yandex.py --playlist user:kind    # плейлист

Зависимости: pip install yandex-music groq supabase rapidfuzz demucs
"""

import subprocess
import json
import sys
import os
import shutil
import time
import re
import difflib
sys.stdout.reconfigure(line_buffering=True)

# Fix OpenMP conflict (libomp loaded twice via torch + demucs)
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
from pathlib import Path
from yandex_music import Client
from yandex_music.exceptions import NotFoundError
from groq import Groq

# Load .env if exists
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for line in _env_path.read_text().split('\n'):
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://anlhvcspsuxpaibnvrxr.supabase.co")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
GROQ_KEY = os.environ["GROQ_KEY"]
YANDEX_TOKEN = os.environ["YANDEX_TOKEN"]

OUTPUT_DIR = Path(__file__).parent / "karaoke_output"
TEMP_DIR = OUTPUT_DIR / "_temp"
PROGRESS_FILE = OUTPUT_DIR / "_progress_yandex.txt"

groq_client = Groq(api_key=GROQ_KEY)
ym_client = None


def get_ym_client():
    global ym_client
    if ym_client is None:
        ym_client = Client(YANDEX_TOKEN).init()
        # Increase default timeout to avoid TimedOutError
        ym_client._request._timeout = 30
        print(f"Яндекс Музыка: авторизован как {ym_client.me.account.login}")
    return ym_client


def with_retry(fn, retries=3, delay=5):
    """Retry wrapper for network calls."""
    for attempt in range(retries):
        try:
            return fn()
        except Exception as e:
            if attempt < retries - 1:
                print(f"    Retry {attempt + 1}/{retries}: {e}")
                time.sleep(delay)
            else:
                raise


def make_slug(artist, title):
    _TR = {
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e',
        'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k',
        'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r',
        'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts',
        'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '',
        'э': 'e', 'ю': 'yu', 'я': 'ya',
    }
    text = f"{artist}_{title}".lower()
    text = ''.join(_TR.get(c, c) for c in text)
    text = re.sub(r'[^a-z0-9]+', '_', text)
    text = re.sub(r'_+', '_', text).strip('_')
    return text[:80]


# --- Яндекс Музыка: поиск, скачивание, тексты ---

def search_track(query):
    """Ищем трек в Яндекс Музыке."""
    client = get_ym_client()
    result = client.search(query)
    if result.best and result.best.type == 'track':
        return result.best.result
    if result.tracks and result.tracks.results:
        return result.tracks.results[0]
    return None


def download_track(track, work_dir):
    """Скачиваем трек в максимальном качестве."""
    print("  [1/5] Скачиваю из Яндекс Музыки...")
    wav_path = work_dir / "original.wav"
    mp3_path = work_dir / "original_ym.mp3"

    # Скачиваем MP3 320kbps
    with_retry(lambda: track.download(str(mp3_path), codec='mp3', bitrate_in_kbps=320))
    size_mb = mp3_path.stat().st_size / 1024 / 1024
    print(f"    Скачано: {size_mb:.1f} МБ (320 kbps)")

    # Конвертируем в WAV для Demucs
    subprocess.run([
        "ffmpeg", "-y", "-i", str(mp3_path),
        "-acodec", "pcm_s16le", "-ar", "44100",
        str(wav_path)
    ], check=True, capture_output=True)

    return wav_path


def get_lrc_lyrics(track):
    """Получаем LRC-текст (построчные тайминги)."""
    try:
        lyrics = track.get_lyrics('LRC')
        lrc_text = lyrics.fetch_lyrics()
        return lrc_text
    except (NotFoundError, Exception):
        return None


def parse_lrc(lrc_text):
    """Парсим LRC в список строк с таймингами.
    Возвращает [(start_sec, text), ...]
    """
    lines = []
    for line in lrc_text.split('\n'):
        match = re.match(r'\[(\d+):(\d+\.\d+)\]\s*(.*)', line)
        if match:
            minutes = int(match.group(1))
            seconds = float(match.group(2))
            text = match.group(3).strip()
            if text:
                start = minutes * 60 + seconds
                lines.append((start, text))
    return lines


def get_plain_lyrics(track):
    """Получаем plain-text из LRC (без таймингов) как эталонный текст."""
    lrc = get_lrc_lyrics(track)
    if lrc:
        parsed = parse_lrc(lrc)
        return '\n'.join(text for _, text in parsed), lrc
    return None, None


# --- Demucs ---

def separate_vocals(wav_path, work_dir):
    """Demucs: вокал + инструментал."""
    print("  [2/5] Demucs: разделяю вокал...")
    env = os.environ.copy()
    env["KMP_DUPLICATE_LIB_OK"] = "TRUE"
    subprocess.run([
        "python3", "-m", "demucs",
        "--two-stems", "vocals", "-d", "mps",
        "-o", str(work_dir / "demucs"),
        str(wav_path)
    ], check=True, capture_output=True, env=env)
    base = work_dir / "demucs" / "htdemucs" / "original"
    return base / "no_vocals.wav", base / "vocals.wav"


# --- Groq Whisper ---

def get_leading_silence(wav_path):
    result = subprocess.run([
        "ffmpeg", "-i", str(wav_path),
        "-af", "silencedetect=noise=-40dB:d=0.5",
        "-f", "null", "-"
    ], capture_output=True, text=True)
    # Parse silence_start/silence_end pairs, only use leading silence (starts near 0)
    last_start = None
    for line in result.stderr.splitlines():
        if "silence_start" in line:
            parts = line.split("silence_start:")[1].split()[0].strip()
            last_start = float(parts)
        elif "silence_end" in line:
            parts = line.split("silence_end:")[1].split("|")[0].strip()
            end = float(parts)
            # Only count as leading silence if it starts within first 0.5s
            if last_start is not None and last_start < 0.5:
                return end
            return 0.0  # First silence block isn't at the start
    return 0.0


def trim_silence(wav_path, out_path):
    subprocess.run([
        "ffmpeg", "-y", "-i", str(wav_path),
        "-af", "silenceremove=start_periods=1:start_silence=0.5:start_threshold=-40dB,"
               "areverse,silenceremove=start_periods=1:start_silence=0.5:start_threshold=-40dB,areverse",
        str(out_path)
    ], check=True, capture_output=True)


def transcribe_groq(vocals_wav_path, language="ru"):
    """Groq Whisper: word-level тайминги."""
    print(f"  [3/5] Groq Whisper: word-level тайминги ({language})...")

    silence_offset = get_leading_silence(vocals_wav_path)
    if silence_offset > 0:
        print(f"    Тишина в начале: {silence_offset:.2f}с")

    trimmed_wav = vocals_wav_path.parent / "vocals_trimmed.wav"
    trim_silence(vocals_wav_path, trimmed_wav)

    vocals_mp3 = vocals_wav_path.parent / "vocals_groq.mp3"
    subprocess.run([
        "ffmpeg", "-y", "-i", str(trimmed_wav),
        "-codec:a", "libmp3lame", "-b:a", "128k",
        str(vocals_mp3)
    ], check=True, capture_output=True)

    size_mb = vocals_mp3.stat().st_size / 1024 / 1024
    if size_mb > 25:
        raise Exception(f"Vocals MP3 слишком большой: {size_mb:.1f} МБ")

    prompt = "Песня на русском языке." if language == "ru" else "Song lyrics in English."

    with open(vocals_mp3, "rb") as f:
        result = groq_client.audio.transcriptions.create(
            model="whisper-large-v3-turbo",
            file=("vocals.mp3", f),
            language=language,
            response_format="verbose_json",
            timestamp_granularities=["word"],
            prompt=prompt,
        )

    raw_words = result.words if result.words else []

    # Filter out prompt leak words (Whisper sometimes includes the prompt text)
    prompt_leak = {"песня", "на", "русском", "языке", "song", "lyrics", "in", "english", "текст"}

    words = []
    for w in raw_words:
        if isinstance(w, dict):
            word = w["word"].strip()
            start = w["start"]
            end = w["end"]
        else:
            word = w.word.strip()
            start = w.start
            end = w.end

        if not word:
            continue

        # Skip prompt leak: words at the very start (< 0.5s) matching prompt tokens
        if start < 0.5 and word.lower().rstrip('.,') in prompt_leak:
            continue

        words.append({"word": word,
                      "start": round(start + silence_offset, 2),
                      "end": round(end + silence_offset, 2)})

    print(f"    Whisper: {len(words)} слов")
    return words


# --- Merge: LRC текст + Whisper тайминги ---

def words_from_lrc_lines(lrc_text):
    """Создаём word-level тайминги из LRC line-level таймингов.
    Распределяем слова равномерно внутри каждой строки."""
    parsed = parse_lrc(lrc_text)
    if not parsed:
        return []

    words = []
    for i, (line_start, line_text) in enumerate(parsed):
        # Определяем конец строки = начало следующей (или +3с для последней)
        # Но ограничиваем макс. длительность строки: не более 1с на слово
        if i + 1 < len(parsed):
            # Оставляем 0.15с gap между строками для естественной паузы
            line_end = parsed[i + 1][0] - 0.15
        else:
            line_end = line_start + 3.0

        # Парсим слова с поддержкой бэк-вокала
        in_backing = False
        line_words = []
        for char_group in re.split(r'(\(|\))', line_text):
            if char_group == '(':
                in_backing = True
                continue
            elif char_group == ')':
                in_backing = False
                continue
            for w in char_group.split():
                cleaned = w.strip('.,!?;:«»""—–…\'"')
                if cleaned:
                    line_words.append((cleaned, in_backing))

        if not line_words:
            continue

        # Ограничиваем длительность строки: макс ~1с на слово
        # (предотвращает растягивание 3 слов на 13 секунд перед проигрышем)
        max_line_dur = len(line_words) * 1.0
        duration = min(line_end - line_start, max_line_dur)
        word_dur = duration / len(line_words)
        for j, (word, is_backing) in enumerate(line_words):
            entry = {
                "word": word,
                "start": round(line_start + j * word_dur, 2),
                "end": round(line_start + (j + 1) * word_dur, 2),
            }
            if is_backing:
                entry["backing"] = True
            words.append(entry)

    return words


def merge_lrc_with_whisper(lrc_text, whisper_words):
    """Заменяем слова Whisper на текст из LRC, сохраняя word-level тайминги.
    Бэк-вокал в скобках помечается флагом backing=True.

    Если Whisper распознал менее 50% слов от LRC — используем LRC line-level
    тайминги напрямую (более надёжно, чем difflib с большими insert-блоками)."""

    # Собираем слова из LRC, помечая бэк-вокал
    lrc_words = []  # list of (word, is_backing)
    in_backing = False
    for line in lrc_text.split('\n'):
        line = re.sub(r'\[\d+:\d+\.\d+\]', '', line).strip()
        for char_group in re.split(r'(\(|\))', line):
            if char_group == '(':
                in_backing = True
                continue
            elif char_group == ')':
                in_backing = False
                continue
            for word in char_group.split():
                cleaned = word.strip('.,!?;:«»""—–…\'"')
                if cleaned:
                    lrc_words.append((cleaned, in_backing))

    if not lrc_words or not whisper_words:
        return whisper_words

    # If Whisper recognized less than 50% of LRC words, use LRC line-level timing
    # (difflib creates too many fake insert blocks when ratio is low)
    ratio = len(whisper_words) / len(lrc_words)
    if ratio < 0.5:
        print(f"    Whisper/LRC ratio: {ratio:.1%} — используем LRC line-level тайминги")
        return words_from_lrc_lines(lrc_text)

    # Helper to build word entry
    def make_word(lrc_idx, start, end):
        text, is_backing = lrc_words[lrc_idx]
        entry = {"word": text, "start": start, "end": end}
        if is_backing:
            entry["backing"] = True
        return entry

    # difflib alignment — compare text only (not backing flag)
    w_norm = [w["word"].lower().rstrip('.,!?;:') for w in whisper_words]
    l_norm = [w[0].lower() for w in lrc_words]

    matcher = difflib.SequenceMatcher(None, w_norm, l_norm)
    opcodes = matcher.get_opcodes()
    merged = []

    for idx, (op, w_start, w_end, l_start, l_end) in enumerate(opcodes):
        if op == 'equal':
            for i, j in zip(range(w_start, w_end), range(l_start, l_end)):
                merged.append(make_word(j, whisper_words[i]["start"], whisper_words[i]["end"]))
        elif op == 'replace':
            t_start = whisper_words[w_start]["start"]
            t_end = whisper_words[w_end - 1]["end"]
            t_span = t_end - t_start
            l_count = l_end - l_start
            for k in range(l_count):
                frac_start = k / l_count
                frac_end = (k + 1) / l_count
                merged.append(make_word(
                    l_start + k,
                    round(t_start + t_span * frac_start, 2),
                    round(t_start + t_span * frac_end, 2),
                ))
        elif op == 'insert':
            # Find time boundaries: previous end → next start
            t_begin = merged[-1]["end"] if merged else 0
            t_finish = t_begin  # default: look ahead for next whisper anchor
            for next_op, nw_start, nw_end, _, _ in opcodes[idx + 1:]:
                if next_op in ('equal', 'replace', 'delete') and nw_start < len(whisper_words):
                    t_finish = whisper_words[nw_start]["start"]
                    break
            # If no future anchor found, estimate ~0.4s per word
            l_count = l_end - l_start
            if t_finish <= t_begin:
                t_finish = t_begin + l_count * 0.4
            t_span = t_finish - t_begin
            for k in range(l_count):
                frac_start = k / l_count
                frac_end = (k + 1) / l_count
                merged.append(make_word(
                    l_start + k,
                    round(t_begin + t_span * frac_start, 2),
                    round(t_begin + t_span * frac_end, 2),
                ))
        elif op == 'delete':
            for i in range(w_start, w_end):
                merged.append(whisper_words[i].copy())

    return merged


def tighten_timings(words, max_gap=0.3):
    """Убираем паузы между словами — растягиваем end до start следующего.

    В пении слова идут слитно, но Whisper ставит зазоры как в речи.
    max_gap: если пауза > этого (секунды), считаем это реальной паузой
    (проигрыш, вдох) и не трогаем.
    """
    if len(words) < 2:
        return words

    for i in range(len(words) - 1):
        gap = words[i + 1]["start"] - words[i]["end"]
        if 0 < gap <= max_gap:
            # Маленький зазор — растягиваем слово до следующего
            words[i]["end"] = words[i + 1]["start"]

    return words


# --- Upload ---

def convert_mp3(wav_path, mp3_path):
    subprocess.run([
        "ffmpeg", "-y", "-i", str(wav_path),
        "-codec:a", "libmp3lame", "-b:a", "128k",
        str(mp3_path)
    ], check=True, capture_output=True)


def upload_to_supabase(mp3_path, slug, title, artist, words, duration, source_info):
    print("  [5/5] Загружаю в Supabase...")
    from supabase import create_client
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    filename = f"{slug}.mp3"
    try:
        sb.storage.from_("karaoke").remove([filename])
    except Exception:
        pass

    with open(mp3_path, "rb") as f:
        sb.storage.from_("karaoke").upload(filename, f, {"content-type": "audio/mpeg"})

    audio_url = sb.storage.from_("karaoke").get_public_url(filename)

    result = sb.table("karaoke_songs").insert({
        "title": title,
        "artist": artist,
        "audio_path": audio_url,
        "lyrics": words,
        "duration_sec": duration,
        "source_url": source_info,
    }).execute()

    return result.data[0]["id"]


def detect_language(title, artist):
    text = title + artist
    if any('\u0400' <= c <= '\u04FF' for c in text):
        return "ru"
    return "en"


# --- Progress ---

def load_progress():
    if PROGRESS_FILE.exists():
        return set(PROGRESS_FILE.read_text().strip().split('\n'))
    return set()


def save_progress(key):
    with open(PROGRESS_FILE, 'a') as f:
        f.write(key + '\n')


# --- Process ---

def process_track_by_query(query):
    """Обработка: поиск в YM → скачивание → Demucs → Whisper → merge → Supabase."""
    work_dir = TEMP_DIR / "current"
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        # Поиск
        track = search_track(query)
        if not track:
            print(f"  ✗ Не найдено в Яндекс Музыке: {query}")
            return False

        artists = ', '.join(a.name for a in track.artists)
        title = track.title
        duration = (track.duration_ms or 0) // 1000
        lang = detect_language(title, artists)
        slug = make_slug(artists, title)

        print(f"  {artists} — {title}")
        print(f"  Язык: {lang}, Длительность: {duration}с, YM ID: {track.id}")

        # 1. LRC тексты (если есть — пропускаем Whisper)
        print("  [1/4] Яндекс Music: LRC тексты...")
        plain_text, lrc_raw = with_retry(lambda: get_plain_lyrics(track))

        if lrc_raw:
            parsed_lines = parse_lrc(lrc_raw)
            print(f"    LRC найден: {len(parsed_lines)} строк")
            words = words_from_lrc_lines(lrc_raw)
            words = tighten_timings(words)
            lyrics_source = "yandex_lrc"
            print(f"    {len(words)} слов (LRC line-level)")
        else:
            words = None
            lyrics_source = None

        # 2. Скачиваем + Demucs
        wav_path = download_track(track, work_dir)
        no_vocals, vocals = separate_vocals(wav_path, work_dir)

        # 3. Whisper fallback (только если нет LRC)
        if words is None:
            print("  [3/4] Groq Whisper (нет LRC)...")
            whisper_words = with_retry(lambda: transcribe_groq(vocals, lang))
            words = tighten_timings(whisper_words)
            lyrics_source = "whisper"
            print(f"    {len(words)} слов (Whisper)")

        # 4. Upload
        mp3_path = OUTPUT_DIR / f"{slug}.mp3"
        convert_mp3(no_vocals, mp3_path)

        source_info = f"yandex:{track.id}"
        song_id = upload_to_supabase(mp3_path, slug, title, artists, words, duration, source_info)
        print(f"  ✓ Готово! ID: {song_id}")
        print(f"  ✓ Слов: {len(words)}, Источник: {lyrics_source}")
        return True

    except Exception as e:
        print(f"  ✗ Ошибка: {e}")
        import traceback
        traceback.print_exc()
        return False

    finally:
        if work_dir.exists():
            shutil.rmtree(work_dir)


def process_track_by_id(track_id):
    """Обработка по ID трека Яндекс Музыки."""
    work_dir = TEMP_DIR / "current"
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        client = get_ym_client()
        tracks = with_retry(lambda: client.tracks([track_id]))
        if not tracks:
            print(f"  ✗ Трек {track_id} не найден")
            return False

        track = tracks[0]
        artists = ', '.join(a.name for a in track.artists)
        title = track.title
        duration = (track.duration_ms or 0) // 1000
        lang = detect_language(title, artists)
        slug = make_slug(artists, title)

        print(f"  {artists} — {title}")
        print(f"  Язык: {lang}, Длительность: {duration}с, YM ID: {track.id}")

        # 1. LRC тексты (если есть — пропускаем Whisper)
        print("  [1/4] Яндекс Music: LRC тексты...")
        plain_text, lrc_raw = with_retry(lambda: get_plain_lyrics(track))

        if lrc_raw:
            parsed_lines = parse_lrc(lrc_raw)
            print(f"    LRC найден: {len(parsed_lines)} строк")
            words = words_from_lrc_lines(lrc_raw)
            words = tighten_timings(words)
            lyrics_source = "yandex_lrc"
            print(f"    {len(words)} слов (LRC line-level)")
        else:
            words = None
            lyrics_source = None

        # 2. Скачиваем + Demucs
        wav_path = download_track(track, work_dir)
        no_vocals, vocals = separate_vocals(wav_path, work_dir)

        # 3. Whisper fallback (только если нет LRC)
        if words is None:
            print("  [3/4] Groq Whisper (нет LRC)...")
            whisper_words = with_retry(lambda: transcribe_groq(vocals, lang))
            words = tighten_timings(whisper_words)
            lyrics_source = "whisper"
            print(f"    {len(words)} слов (Whisper)")

        # 4. Upload
        mp3_path = OUTPUT_DIR / f"{slug}.mp3"
        convert_mp3(no_vocals, mp3_path)

        song_id = with_retry(lambda: upload_to_supabase(mp3_path, slug, title, artists, words, duration, f"yandex:{track.id}"))
        print(f"  ✓ Готово! ID: {song_id}")
        print(f"  ✓ Слов: {len(words)}, Источник: {lyrics_source}")
        return True

    except Exception as e:
        print(f"  ✗ Ошибка: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        if work_dir.exists():
            shutil.rmtree(work_dir)


def get_album_tracks(album_id):
    """Получаем список треков из альбома."""
    client = get_ym_client()
    album = client.albums_with_tracks(album_id)
    tracks = []
    for volume in album.volumes:
        tracks.extend(volume)
    return tracks


def get_playlist_tracks(user_id, kind):
    """Получаем список треков из плейлиста."""
    client = get_ym_client()
    playlist = client.users_playlists(kind, user_id)
    return [t.track for t in playlist.tracks if t.track]


def get_playlist_tracks_by_uuid(uuid):
    """Получаем список треков из shared-плейлиста по UUID."""
    client = get_ym_client()
    result = client._request.get(f'https://api.music.yandex.net/playlist/{uuid}')
    tracks = []
    for t in result.get('tracks', []):
        track_data = t.get('track')
        if track_data:
            track_id = str(track_data['id'])
            artists = ', '.join(a['name'] for a in track_data.get('artists', []))
            title = track_data.get('title', '')
            tracks.append((track_id, artists, title))
    return tracks


def main():
    args = sys.argv[1:]
    if not args:
        print("Караоке-конвейер v3: Яндекс Музыка + Groq Whisper")
        print()
        print("Использование:")
        print("  python3 karaoke_yandex.py \"Кино - Группа крови\" \"Руки Вверх - Крошка моя\"")
        print("  python3 karaoke_yandex.py --album ALBUM_ID")
        print("  python3 karaoke_yandex.py --playlist USER_ID:KIND")
        print("  python3 karaoke_yandex.py --playlist UUID")
        print("  python3 karaoke_yandex.py --playlist https://music.yandex.ru/playlists/UUID")
        print()
        print("Прогресс сохраняется — можно прервать и продолжить.")
        sys.exit(1)

    OUTPUT_DIR.mkdir(exist_ok=True)
    TEMP_DIR.mkdir(exist_ok=True)

    # Собираем задачи: список (track_id, query)
    tasks = []

    if args[0] == '--album' and len(args) > 1:
        album_id = args[1]
        print(f"Загружаю альбом {album_id}...")
        tracks = get_album_tracks(album_id)
        for t in tracks:
            artists = ', '.join(a.name for a in t.artists)
            tasks.append((str(t.id), f"{artists} - {t.title}"))
        print(f"  Найдено {len(tasks)} треков")

    elif args[0] == '--playlist' and len(args) > 1:
        playlist_arg = args[1]

        # Extract UUID from URL if needed
        url_match = re.search(r'playlists/([0-9a-f-]{36})', playlist_arg)
        if url_match:
            playlist_arg = url_match.group(1)

        # UUID format (shared playlist)
        uuid_match = re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', playlist_arg)
        if uuid_match:
            print(f"Загружаю shared-плейлист {playlist_arg}...")
            track_list = get_playlist_tracks_by_uuid(playlist_arg)
            for track_id, artists, title in track_list:
                tasks.append((track_id, f"{artists} - {title}"))
            print(f"  Найдено {len(tasks)} треков")
        else:
            # USER_ID:KIND format
            parts = playlist_arg.split(':')
            if len(parts) != 2:
                print("Формат: --playlist USER_ID:KIND или UUID или URL")
                sys.exit(1)
            user_id, kind = parts
            print(f"Загружаю плейлист {user_id}:{kind}...")
            tracks = get_playlist_tracks(user_id, kind)
            for t in tracks:
                artists = ', '.join(a.name for a in t.artists)
                tasks.append((str(t.id), f"{artists} - {t.title}"))
            print(f"  Найдено {len(tasks)} треков")

    else:
        # Текстовые запросы
        for q in args:
            tasks.append((None, q))

    # Пропускаем обработанные
    done = load_progress()
    original_count = len(tasks)
    tasks = [(tid, q) for tid, q in tasks if (tid or q) not in done]
    if original_count > len(tasks):
        print(f"Уже обработано: {original_count - len(tasks)} (пропускаю)")

    total = len(tasks)
    print(f"К обработке: {total}")

    if total == 0:
        print("Все треки уже обработаны!")
        return

    ok, fail = 0, 0
    track_times = []
    batch_start = time.time()

    for i, (track_id, query) in enumerate(tasks, 1):
        if track_times:
            avg = sum(track_times) / len(track_times)
            remaining = (total - i + 1) * avg
            eta_str = f" | ETA: {int(remaining // 60)}м {int(remaining % 60)}с"
        else:
            eta_str = ""

        print(f"\n{'='*60}")
        print(f"  [{i}/{total}]{eta_str}")
        print(f"{'='*60}")

        t0 = time.time()
        try:
            if track_id:
                success = process_track_by_id(track_id)
            else:
                success = process_track_by_query(query)
        except Exception as e:
            print(f"  ✗ Критическая ошибка: {e}")
            success = False

        elapsed = time.time() - t0
        track_times.append(elapsed)
        print(f"  Время: {int(elapsed // 60)}м {int(elapsed % 60)}с")

        if success:
            ok += 1
            save_progress(track_id or query)
        else:
            fail += 1

        # Пауза между треками чтобы API не дросселил
        if i < total:
            time.sleep(5)

    total_elapsed = time.time() - batch_start
    print(f"\n{'='*60}")
    print(f"Готово: {ok} успешно, {fail} ошибок")
    print(f"Общее время: {int(total_elapsed // 60)}м {int(total_elapsed % 60)}с")
    if track_times:
        avg = sum(track_times) / len(track_times)
        print(f"Среднее на трек: {int(avg // 60)}м {int(avg % 60)}с")

    if TEMP_DIR.exists():
        shutil.rmtree(TEMP_DIR)


if __name__ == "__main__":
    main()
