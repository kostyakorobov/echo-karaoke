import { ROOM_ID, VIDEO_URL } from './config.js';
import { sb, cmdChannel, getSongById, getSongMeta, getNextWaiting, getQueueWaiting, getCurrentPlaying, getLastDone, setQueueStatus, broadcastState, upsertDeviceStatus } from './supabase.js';
import { parseWords, clearLyrics, getLines, isInterludeVisible, renderLine, renderNextLine, findCurrentLineIdx, updateInterlude, hideInterlude } from './lyrics.js';
import { initFx, initCongratsFx } from './fx.js';
import { showCongrats, hideCongrats, showCountdown } from './congrats.js';
import { initBrowse, showBrowse, hideBrowse, isBrowseVisible, refreshBrowseQueue } from './browse.js';

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

const audio = document.getElementById('audio');
let currentSong = null;
let lastSingerName = '';
let toastTimer = null;
let checkingQueue = false;
let skipping = false;
let goingBack = false;
let lastError = null;

// Capture uncaught sync errors
window.onerror = (msg, src, line) => {
    lastError = `${msg} (${src}:${line})`;
};
// Capture uncaught async errors (Promise rejections)
window.addEventListener('unhandledrejection', (e) => {
    lastError = `Unhandled rejection: ${e.reason?.message || e.reason}`;
});

// --- Room config (congrats_text, etc.) ---
const CONGRATS_DEFAULT = 'Отличное выступление!';

async function applyRoomConfig() {
    const { data } = await sb.from('rooms')
        .select('congrats_text')
        .eq('id', ROOM_ID)
        .maybeSingle();
    const el = document.getElementById('congratsLabel');
    if (el) el.textContent = (data?.congrats_text || CONGRATS_DEFAULT);
}

applyRoomConfig();

sb.channel(`room_config_${ROOM_ID}`)
    .on('postgres_changes', {
        event: 'UPDATE', schema: 'public',
        table: 'rooms', filter: `id=eq.${ROOM_ID}`
    }, () => applyRoomConfig())
    .subscribe();

// --- Toast ---
function showPlayerToast(title, detail, type = '') {
    document.getElementById('toastSong').textContent = title;
    document.getElementById('toastDetail').textContent = detail;
    const toast = document.getElementById('playerToast');
    toast.className = 'player-toast show' + (type ? ' ' + type : '');
    const label = document.getElementById('toastLabel');
    if (label) {
        if (type === 'error') label.textContent = 'Ошибка';
        else if (type === 'warning') label.textContent = 'Внимание';
        else label.textContent = 'Добавлено в очередь';
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), type === 'error' ? 5000 : 4000);
}

// --- Queue display (karaoke screen header) ---
async function updateQueueDisplay() {
    const items = await getQueueWaiting(5);
    const container = document.getElementById('queueList');
    if (!items.length) { container.innerHTML = ''; return; }
    container.innerHTML = items.map((item, i) => {
        const title = esc(item.karaoke_songs?.title || '—');
        const artist = esc(item.karaoke_songs?.artist || '');
        const singer = esc(item.user_name || '');
        return `<div class="queue-list-item">` +
            `<span class="q-pos">${i + 1}.</span>` +
            `<span class="q-song">${artist} — ${title}</span>` +
            (singer ? ` <span class="q-singer">${singer}</span>` : '') +
            `</div>`;
    }).join('');
}

// --- Show karaoke screen ---
function showKaraoke() {
    hideBrowse();
    document.getElementById('karaokeScreen').classList.remove('hidden');
}

// --- Go to browse (new idle) ---
async function goToBrowse() {
    document.getElementById('karaokeScreen').classList.add('hidden');
    currentSong = null;
    clearLyrics();
    await showBrowse();
}

// --- Load song ---
async function loadSong(songId, userName) {
    const song = await getSongById(songId);
    if (!song) return;

    showKaraoke();
    currentSong = song;
    lastSingerName = userName || '';
    audio.src = song.audio_path;
    document.getElementById('title').textContent = song.title;
    document.getElementById('nowDot').style.display = '';
    const metaParts = [esc(song.artist)];
    if (userName) metaParts.push(`<span class="singer-name">${esc(userName)}</span>`);
    document.getElementById('nowMeta').innerHTML = metaParts.join(' · ');
    document.getElementById('singer').innerHTML = userName
        ? `Поёт: <span>${esc(userName)}</span>` : '';

    parseWords(song);

    // Auto-skip on load failure (8s timeout)
    const loadTimeout = setTimeout(() => {
        if (audio.readyState < 2) {
            lastError = `Audio load timeout: ${song.title}`;
            showPlayerToast('Песня недоступна', 'Переходим к следующей', 'error');
            setTimeout(() => skipToNext(), 2000);
        }
    }, 8000);
    audio.addEventListener('canplay', () => clearTimeout(loadTimeout), { once: true });

    try {
        await audio.play();
        document.getElementById('iPlay').style.display = 'none';
        document.getElementById('iPause').style.display = '';
    } catch (e) {
        console.warn('Autoplay blocked:', e.message);
        document.getElementById('iPlay').style.display = '';
        document.getElementById('iPause').style.display = 'none';
    }
    updateQueueDisplay();
}

// --- Check queue ---
async function checkQueue() {
    if (checkingQueue) return;
    checkingQueue = true;
    try {
        const next = await getNextWaiting();
        if (next) {
            await setQueueStatus(next.id, 'playing');
            await loadSong(next.song_id, next.user_name);
        }
    } finally { checkingQueue = false; }
}

// --- Skip ---
async function skipToNext() {
    if (skipping) return;
    skipping = true;

    audio.pause();
    document.getElementById('line1').innerHTML = '';
    document.getElementById('singer').innerHTML = '';
    hideInterlude();

    const playing = await getCurrentPlaying();
    if (playing) await setQueueStatus(playing.id, 'done');

    const next = await getNextWaiting();
    if (next) {
        const nextTitle = next.karaoke_songs?.title || '—';
        const nextArtist = next.karaoke_songs?.artist || '';
        const nextSinger = next.user_name || '';
        await showCountdown(nextTitle, nextArtist, nextSinger, lastSingerName);
        await setQueueStatus(next.id, 'playing');
        await loadSong(next.song_id, next.user_name);
    } else {
        goToBrowse();
    }
    updateQueueDisplay();
    skipping = false;
}

// --- Restart / Previous ---
async function restartOrPrevious() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (goingBack) return;
    goingBack = true;
    try {
        const prev = await getLastDone();
        if (!prev) { audio.currentTime = 0; return; }

        audio.pause();
        const playing = await getCurrentPlaying();
        if (playing) await setQueueStatus(playing.id, 'waiting');
        await setQueueStatus(prev.id, 'playing');
        await loadSong(prev.song_id, prev.user_name);
        updateQueueDisplay();
    } finally { goingBack = false; }
}

// --- Track ended ---
audio.addEventListener('ended', async () => {
    if (skipping) return;
    const finishedSinger = lastSingerName;
    const finishedTitle = currentSong?.title || '';
    const finishedArtist = currentSong?.artist || '';

    const playing = await getCurrentPlaying();
    if (playing) await setQueueStatus(playing.id, 'done');

    showCongrats(finishedSinger, finishedTitle, finishedArtist);

    const next = await getNextWaiting();
    if (next) {
        await new Promise(r => setTimeout(r, 5000));
        hideCongrats();
        const nextTitle = next.karaoke_songs?.title || '—';
        const nextArtist = next.karaoke_songs?.artist || '';
        const nextSinger = next.user_name || '';
        await showCountdown(nextTitle, nextArtist, nextSinger, finishedSinger);
        await setQueueStatus(next.id, 'playing');
        await loadSong(next.song_id, next.user_name);
    } else {
        await new Promise(r => setTimeout(r, 5000));
        hideCongrats();
        goToBrowse();
    }
    updateQueueDisplay();
});

// --- Broadcast state ---
audio.addEventListener('play', () => broadcastState('playing'));
audio.addEventListener('pause', () => broadcastState('paused'));
audio.addEventListener('ended', () => broadcastState('ended'));

// --- Realtime queue changes ---
// --- Connection status ---
const queueDot = document.querySelector('.queue-dot');
const queueChannel = sb.channel('karaoke_queue_changes');

queueChannel.on('system', {}, ({ status }) => {
    if (queueDot) {
        queueDot.className = 'queue-dot ' + (
            status === 'SUBSCRIBED' ? 'connected' :
            status === 'CHANNEL_ERROR' ? 'disconnected' : 'reconnecting'
        );
    }
    if (status === 'CHANNEL_ERROR') lastError = 'Supabase connection lost';
});

queueChannel
    .on('postgres_changes', {
        event: 'INSERT', schema: 'public',
        table: 'karaoke_queue', filter: `room_id=eq.${ROOM_ID}`
    }, async (payload) => {
        const row = payload.new;
        const song = await getSongMeta(row.song_id);
        if (song) showPlayerToast(song.title, (song.artist ? song.artist + ' — ' : '') + (row.user_name ? `Поёт: ${row.user_name}` : ''));
        updateQueueDisplay();
        refreshBrowseQueue();
        if (!currentSong && !isBrowseVisible()) checkQueue();
        if (!currentSong && isBrowseVisible()) {
            // Auto-start if someone adds from mobile remote
            checkQueue();
        }
    })
    .on('postgres_changes', {
        event: 'UPDATE', schema: 'public',
        table: 'karaoke_queue', filter: `room_id=eq.${ROOM_ID}`
    }, () => { updateQueueDisplay(); refreshBrowseQueue(); })
    .on('postgres_changes', {
        event: 'DELETE', schema: 'public',
        table: 'karaoke_queue', filter: `room_id=eq.${ROOM_ID}`
    }, () => { updateQueueDisplay(); refreshBrowseQueue(); })
    .subscribe();

// --- Remote commands ---
cmdChannel.on('broadcast', { event: 'player_command' }, ({ payload }) => {
    const { command, value } = payload;
    switch (command) {
        case 'play':
            if (audio.paused && currentSong) {
                audio.play();
                document.getElementById('iPlay').style.display = 'none';
                document.getElementById('iPause').style.display = '';
            }
            break;
        case 'pause':
            if (!audio.paused) {
                audio.pause();
                document.getElementById('iPlay').style.display = '';
                document.getElementById('iPause').style.display = 'none';
            }
            break;
        case 'seek':
            audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + value));
            break;
        case 'restart': restartOrPrevious(); break;
        case 'skip': skipToNext(); break;
    }
}).subscribe();

// --- Controls ---
document.getElementById('play').onclick = async () => {
    if (audio.paused) {
        if (currentSong) {
            audio.play();
            document.getElementById('iPlay').style.display = 'none';
            document.getElementById('iPause').style.display = '';
        }
    } else {
        audio.pause();
        document.getElementById('iPlay').style.display = '';
        document.getElementById('iPause').style.display = 'none';
    }
};
document.getElementById('restart').onclick = () => restartOrPrevious();
document.getElementById('skip').onclick = () => skipToNext();
document.getElementById('bar').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
};
document.addEventListener('keydown', (e) => {
    if (isBrowseVisible()) return; // browse.js handles keys in browse mode
    if (e.code === 'Space') { e.preventDefault(); document.getElementById('play').click(); }
    if (e.code === 'ArrowRight') audio.currentTime += 5;
    if (e.code === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
});

// --- Tick ---
function fmt(s) {
    return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

function tick() {
    const t = audio.currentTime;
    if (audio.duration) {
        document.getElementById('fill').style.width = (t / audio.duration * 100) + '%';
        document.getElementById('cur').textContent = fmt(t);
        document.getElementById('dur').textContent = fmt(audio.duration);
    }
    updateInterlude(t, audio.paused);
    const lines = getLines();
    if (lines.length > 0) {
        const line0 = document.getElementById('line0');
        const line1 = document.getElementById('line1');
        const line2 = document.getElementById('line2');
        if (!isInterludeVisible() || line1.style.opacity !== '0') {
            let idx = findCurrentLineIdx(t);
            // During interlude, preview the upcoming line (not the already-sung one)
            // But only bump ONCE — if findCurrentLineIdx already returned the next line
            // (via look-ahead), don't double-bump
            if (isInterludeVisible() && idx + 1 < lines.length) {
                const lastWordEnd = lines[idx][lines[idx].length - 1].end;
                if (t > lastWordEnd + 1) {
                    idx = idx + 1;
                }
            }
            renderNextLine(line0, idx > 0 ? lines[idx - 1] : null);
            renderLine(line1, lines[idx] || null, t);
            renderNextLine(line2, lines[idx + 1] || null);
        } else {
            line0.innerHTML = '';
            line1.innerHTML = '';
            line2.innerHTML = '';
        }
    }
    requestAnimationFrame(tick);
}

// --- Video pre-roll ---
async function playVideo() {
    if (!VIDEO_URL) return;

    const overlay = document.getElementById('videoOverlay');
    const video = document.getElementById('promoVideo');
    const skipBtn = document.getElementById('videoSkip');

    video.src = VIDEO_URL;
    overlay.classList.remove('hidden');

    return new Promise(resolve => {
        video.play().catch(() => { resolve(); });
        video.onended = () => {
            overlay.classList.add('hidden');
            resolve();
        };
        skipBtn.onclick = () => {
            video.pause();
            overlay.classList.add('hidden');
            resolve();
        };
    });
}

// --- Splash ---
document.getElementById('browseRoom').textContent = ROOM_ID;
document.getElementById('roomId').textContent = ROOM_ID;

document.getElementById('splashBtn').onclick = async () => {
    // Unlock autoplay
    const silence = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
    try { await silence.play(); } catch(e) {}
    document.getElementById('splash').classList.add('hidden');

    // Init effects
    initFx();
    initCongratsFx();

    // Init browse with callback for when a song is selected
    initBrowse(() => checkQueue());

    // Play pre-roll video if configured
    await playVideo();

    // Show browse catalog
    await showBrowse();

    // Check if there's already something in queue
    checkQueue();
};

requestAnimationFrame(tick);

// Heartbeat — every 30s
setInterval(async () => {
    const state = lastError ? 'error'
        : (currentSong && !audio.paused) ? 'playing'
        : 'idle';
    const songTitle = currentSong ? `${currentSong.artist} — ${currentSong.title}` : null;
    const queueItems = await getQueueWaiting(100);
    await upsertDeviceStatus(state, songTitle, queueItems.length, lastError);
    if (lastError) lastError = null;
}, 30000);
