import { ROOM_ID } from './config.js';
import { sb, cmdChannel, getSongById, getSongMeta, getFirstSong, getNextWaiting, getQueueWaiting, getCurrentPlaying, getLastDone, setQueueStatus, broadcastState } from './supabase.js';
import { parseWords, clearLyrics, getLines, isInterludeVisible, renderLine, findCurrentLineIdx, updateInterlude, hideInterlude } from './lyrics.js';
import { initFx, initCongratsFx } from './fx.js';
import { showCongrats, hideCongrats, showCountdown } from './congrats.js';

const audio = document.getElementById('audio');
let currentSong = null;
let lastSingerName = '';
let toastTimer = null;
let checkingQueue = false;
let skipping = false;
let goingBack = false;

// --- Toast ---
function showPlayerToast(title, artist, userName) {
    document.getElementById('toastSong').textContent = title;
    document.getElementById('toastDetail').textContent =
        (artist ? artist + ' — ' : '') + (userName ? `Поёт: ${userName}` : '');
    const toast = document.getElementById('playerToast');
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
}

// --- Queue display ---
async function updateQueueDisplay() {
    const items = await getQueueWaiting(5);
    const container = document.getElementById('queueList');
    if (!items.length) { container.innerHTML = ''; return; }
    container.innerHTML = items.map((item, i) => {
        const title = item.karaoke_songs?.title || '—';
        const artist = item.karaoke_songs?.artist || '';
        const singer = item.user_name || '';
        return `<div class="queue-list-item">` +
            `<span class="q-pos">${i + 1}.</span>` +
            `<span class="q-song">${artist} — ${title}</span>` +
            (singer ? ` <span class="q-singer">${singer}</span>` : '') +
            `</div>`;
    }).join('');
}

// --- Load song ---
async function loadSong(songId, userName) {
    const song = await getSongById(songId);
    if (!song) return;

    currentSong = song;
    lastSingerName = userName || '';
    audio.src = song.audio_path;
    document.getElementById('title').textContent = song.title;
    document.getElementById('nowDot').style.display = '';
    const metaParts = [song.artist];
    if (userName) metaParts.push(`<span class="singer-name">${userName}</span>`);
    document.getElementById('nowMeta').innerHTML = metaParts.join(' · ');
    document.getElementById('singer').innerHTML = userName
        ? `Поёт: <span>${userName}</span>` : '';

    parseWords(song);

    document.getElementById('idle').classList.add('hidden');
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

// --- Go to idle ---
function goToIdle() {
    document.getElementById('idle').classList.remove('hidden');
    document.getElementById('idleStatus').textContent = 'Очередь пуста';
    document.getElementById('iPlay').style.display = '';
    document.getElementById('iPause').style.display = 'none';
    document.getElementById('title').textContent = '—';
    document.getElementById('nowMeta').innerHTML = '';
    document.getElementById('nowDot').style.display = 'none';
    document.getElementById('queueList').innerHTML = '';
    currentSong = null;
    clearLyrics();
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
        goToIdle();
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
        goToIdle();
    }
    updateQueueDisplay();
});

// --- Broadcast state ---
audio.addEventListener('play', () => broadcastState('playing'));
audio.addEventListener('pause', () => broadcastState('paused'));
audio.addEventListener('ended', () => broadcastState('ended'));

// --- Realtime ---
sb.channel('karaoke_queue_changes')
    .on('postgres_changes', {
        event: 'INSERT', schema: 'public',
        table: 'karaoke_queue', filter: `room_id=eq.${ROOM_ID}`
    }, async (payload) => {
        const row = payload.new;
        const song = await getSongMeta(row.song_id);
        if (song) showPlayerToast(song.title, song.artist, row.user_name);
        updateQueueDisplay();
        if (!currentSong) checkQueue();
    })
    .on('postgres_changes', {
        event: 'UPDATE', schema: 'public',
        table: 'karaoke_queue', filter: `room_id=eq.${ROOM_ID}`
    }, () => { updateQueueDisplay(); })
    .on('postgres_changes', {
        event: 'DELETE', schema: 'public',
        table: 'karaoke_queue', filter: `room_id=eq.${ROOM_ID}`
    }, () => { updateQueueDisplay(); })
    .subscribe();

// --- Remote commands ---
cmdChannel.on('broadcast', { event: 'player_command' }, ({ payload }) => {
    const { command, value } = payload;
    switch (command) {
        case 'play':
            if (audio.paused && currentSong) {
                audio.play();
                document.getElementById('idle').classList.add('hidden');
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
        if (!currentSong) {
            const song = await getFirstSong();
            if (song) { await loadSong(song.id, null); return; }
        }
        audio.play();
        document.getElementById('idle').classList.add('hidden');
        document.getElementById('iPlay').style.display = 'none';
        document.getElementById('iPause').style.display = '';
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
        const line1 = document.getElementById('line1');
        if (!isInterludeVisible() || line1.style.opacity !== '0') {
            const idx = findCurrentLineIdx(t);
            renderLine(line1, lines[idx] || null, t);
        } else {
            line1.innerHTML = '';
        }
    }
    requestAnimationFrame(tick);
}

// --- Splash ---
document.getElementById('roomId').textContent = ROOM_ID;

document.getElementById('splashBtn').onclick = async () => {
    const silence = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
    try { await silence.play(); } catch(e) {}
    document.getElementById('splash').classList.add('hidden');

    initFx();
    initCongratsFx();

    const first = await getFirstSong();
    if (first) {
        document.getElementById('idleStatus').textContent = '1 трек в базе — нажмите Play';
    }
    checkQueue();
    updateQueueDisplay();
};

requestAnimationFrame(tick);
