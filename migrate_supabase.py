#!/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13
"""
Echo Karaoke — migrate data from old Supabase project to new one.

Transfers:
  1. Storage bucket "karaoke" (all MP3 files)
  2. Table "karaoke_songs" (with updated audio_path URLs)
  3. Table "karaoke_queue" (current queue state)
  4. Table "device_status" (if exists)

Usage:
  1. Copy .env to .env.new and update SUPABASE_URL / SUPABASE_KEY with new project credentials.
  2. Run:  python3.13 migrate_supabase.py
  3. Review output, then update js/config.js + .env to point at new project.

Prerequisites on the NEW project (run in SQL Editor):
  - Create tables (see CLAUDE.md migration SQL)
  - Create storage bucket "karaoke" (public)
  - Create RPC function karaoke_queue_add
  - Enable Realtime on karaoke_queue and device_status
"""
import os
import sys
import json
import tempfile
from pathlib import Path

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

# --- Load env files ---
def load_env(path):
    env = {}
    if path.exists():
        for line in path.read_text().split('\n'):
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    return env

base_dir = Path(__file__).parent
old_env = load_env(base_dir / ".env")
new_env = load_env(base_dir / ".env.new")

OLD_URL = old_env.get("SUPABASE_URL")
OLD_KEY = old_env.get("SUPABASE_KEY")
NEW_URL = new_env.get("SUPABASE_URL")
NEW_KEY = new_env.get("SUPABASE_KEY")

if not all([OLD_URL, OLD_KEY, NEW_URL, NEW_KEY]):
    print("ERROR: Need SUPABASE_URL and SUPABASE_KEY in both .env (old) and .env.new (new)")
    sys.exit(1)

if OLD_URL == NEW_URL:
    print("ERROR: Old and new SUPABASE_URL are the same. Check .env.new")
    sys.exit(1)

from supabase import create_client

old_sb = create_client(OLD_URL, OLD_KEY)
new_sb = create_client(NEW_URL, NEW_KEY)

BUCKET = "karaoke"


# ── Step 1: Migrate storage ─────────────────────────────────────────────
def migrate_storage():
    print("\n=== Step 1/4: Storage (bucket 'karaoke') ===")

    # Paginate old bucket (API returns max 100 per call)
    files = []
    offset = 0
    page = 1000
    try:
        while True:
            batch = old_sb.storage.from_(BUCKET).list(path='', options={"limit": page, "offset": offset})
            if not batch:
                break
            files.extend(batch)
            if len(batch) < page:
                break
            offset += page
    except Exception as e:
        print(f"  SKIP: could not list old bucket: {e}")
        return {}

    if not files:
        print("  No files in old bucket.")
        return {}

    # Filter actual files (skip folders / .emptyFolderPlaceholder)
    files = [f for f in files if f.get("name") and not f["name"].startswith(".")]
    print(f"  Found {len(files)} files to transfer.")

    url_map = {}  # old_public_url -> new_public_url
    success = 0
    skipped = 0

    # Pre-fetch existing files in new bucket (with pagination)
    existing_names = set()
    offset = 0
    try:
        while True:
            batch = new_sb.storage.from_(BUCKET).list(path='', options={"limit": page, "offset": offset})
            if not batch:
                break
            existing_names.update(ef["name"] for ef in batch if ef.get("name"))
            if len(batch) < page:
                break
            offset += page
    except Exception:
        pass

    for f in files:
        name = f["name"]
        old_public_url = old_sb.storage.from_(BUCKET).get_public_url(name)

        # Check if already exists in new bucket
        try:
            if name in existing_names:
                new_public_url = new_sb.storage.from_(BUCKET).get_public_url(name)
                url_map[old_public_url] = new_public_url
                skipped += 1
                continue
        except Exception:
            pass

        # Download from old
        try:
            data = old_sb.storage.from_(BUCKET).download(name)
        except Exception as e:
            print(f"  FAIL download {name}: {e}")
            continue

        # Upload to new
        try:
            new_sb.storage.from_(BUCKET).upload(name, data, {"content-type": "audio/mpeg"})
        except Exception as e:
            print(f"  FAIL upload {name}: {e}")
            continue

        new_public_url = new_sb.storage.from_(BUCKET).get_public_url(name)
        url_map[old_public_url] = new_public_url
        success += 1
        print(f"  ✓ {name}")

    print(f"  Done: {success} transferred, {skipped} already existed.")
    return url_map


# ── Step 2: Migrate karaoke_songs ────────────────────────────────────────
def migrate_songs(url_map):
    print("\n=== Step 2/4: Table 'karaoke_songs' ===")

    # Fetch all songs (paginate if >1000)
    all_songs = []
    offset = 0
    page_size = 1000
    while True:
        result = old_sb.table("karaoke_songs").select("*").range(offset, offset + page_size - 1).execute()
        batch = result.data or []
        all_songs.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size

    if not all_songs:
        print("  No songs found.")
        return {}

    print(f"  Found {len(all_songs)} songs.")

    # Build old_id -> new_id map for queue migration
    id_map = {}
    success = 0

    for song in all_songs:
        old_id = song.pop("id")
        song.pop("created_at", None)

        # Rewrite audio_path to new Storage URL
        if song.get("audio_path") and song["audio_path"] in url_map:
            song["audio_path"] = url_map[song["audio_path"]]
        elif song.get("audio_path") and OLD_URL in song["audio_path"]:
            # Fallback: simple URL replacement
            song["audio_path"] = song["audio_path"].replace(OLD_URL, NEW_URL)

        try:
            result = new_sb.table("karaoke_songs").insert(song).execute()
            new_id = result.data[0]["id"]
            id_map[old_id] = new_id
            success += 1
        except Exception as e:
            print(f"  FAIL song '{song.get('title')}': {e}")

    print(f"  Done: {success}/{len(all_songs)} songs migrated.")
    return id_map


# ── Step 3: Migrate karaoke_queue ────────────────────────────────────────
def migrate_queue(id_map):
    print("\n=== Step 3/4: Table 'karaoke_queue' ===")

    result = old_sb.table("karaoke_queue").select("*").in_("status", ["waiting", "playing"]).execute()
    rows = result.data or []

    if not rows:
        print("  No active queue items.")
        return

    print(f"  Found {len(rows)} active queue items.")
    success = 0

    for row in rows:
        row.pop("id")
        row.pop("created_at", None)

        old_song_id = row.get("song_id")
        if old_song_id and old_song_id in id_map:
            row["song_id"] = id_map[old_song_id]
        elif old_song_id:
            print(f"  WARN: song_id {old_song_id} not in id_map, skipping queue item")
            continue

        try:
            new_sb.table("karaoke_queue").insert(row).execute()
            success += 1
        except Exception as e:
            print(f"  FAIL queue item: {e}")

    print(f"  Done: {success}/{len(rows)} queue items migrated.")


# ── Step 4: Migrate device_status ────────────────────────────────────────
def migrate_device_status():
    print("\n=== Step 4/4: Table 'device_status' ===")

    try:
        result = old_sb.table("device_status").select("*").execute()
        rows = result.data or []
    except Exception:
        print("  SKIP: table does not exist on old project.")
        return

    if not rows:
        print("  No device_status rows.")
        return

    for row in rows:
        try:
            new_sb.table("device_status").upsert(row).execute()
        except Exception as e:
            print(f"  FAIL {row.get('room_id')}: {e}")

    print(f"  Done: {len(rows)} device status rows migrated.")


# ── Main ─────────────────────────────────────────────────────────────────
def main():
    print(f"Source:  {OLD_URL}")
    print(f"Target:  {NEW_URL}")
    print("=" * 60)

    confirm = input("\nThis will COPY data from source to target. Continue? [y/N] ")
    if confirm.lower() != 'y':
        print("Aborted.")
        sys.exit(0)

    url_map = migrate_storage()
    id_map = migrate_songs(url_map)
    migrate_queue(id_map)
    migrate_device_status()

    print("\n" + "=" * 60)
    print("MIGRATION COMPLETE")
    print("=" * 60)
    print(f"\nSong ID mapping ({len(id_map)} songs):")
    for old_id, new_id in sorted(id_map.items()):
        print(f"  {old_id} -> {new_id}")

    # Save mapping for reference
    mapping_path = base_dir / "migration_id_map.json"
    mapping_path.write_text(json.dumps(id_map, indent=2))
    print(f"\nID mapping saved to {mapping_path}")

    print(f"""
Next steps:
  1. Verify data in new Supabase dashboard
  2. Update js/config.js:
       SUPABASE_URL = '{NEW_URL}'
       SUPABASE_KEY = '<new anon key>'
  3. Update .env with new credentials
  4. Update Modal secret 'echo-karaoke-secrets' with new URL/key
  5. Test: player.html, remote.html, admin.html
  6. Once confirmed working, you can decommission the old project
""")


if __name__ == "__main__":
    main()
