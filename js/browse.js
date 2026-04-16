import { ROOM_ID, BROWSE_PAGE_SIZE } from './config.js';
import { getAllSongs, getQueueWaiting, addSongToQueue } from './supabase.js';

let songs = [];
let filteredSongs = [];
let selectedIndex = 0;
let visible = false;
let onPlay = null; // callback: song added, start checking queue

// --- Init ---
export function initBrowse(onPlayCallback) {
    onPlay = onPlayCallback;
    generateQrCode();
    document.addEventListener('keydown', handleKey);

    const list = document.getElementById('browseList');
    if (list) {
        list.addEventListener('click', (e) => {
            if (!visible) return;
            const item = e.target.closest('.browse-item');
            if (!item) return;
            const idx = parseInt(item.dataset.index, 10);
            if (Number.isNaN(idx)) return;
            selectedIndex = idx;
            selectSong();
        });
    }
}

// --- Show / Hide ---
export async function showBrowse() {
    visible = true;
    document.getElementById('browseScreen').classList.remove('hidden');
    songs = await getAllSongs();
    filteredSongs = songs;
    selectedIndex = 0;
    renderList();
    renderBrowseQueue();
}

export function hideBrowse() {
    visible = false;
    document.getElementById('browseScreen').classList.add('hidden');
}

export function isBrowseVisible() { return visible; }

// --- Render song list ---
function renderList() {
    const list = document.getElementById('browseList');
    if (filteredSongs.length === 0) {
        list.innerHTML = '<div class="browse-empty"><div class="browse-empty-icon">🎤</div>Каталог обновляется</div>';
        return;
    }

    // Paginate around selected index
    const pageStart = Math.max(0, selectedIndex - Math.floor(BROWSE_PAGE_SIZE / 2));
    const pageEnd = Math.min(filteredSongs.length, pageStart + BROWSE_PAGE_SIZE);
    const visibleSongs = filteredSongs.slice(pageStart, pageEnd);

    list.innerHTML = visibleSongs.map((s, i) => {
        const realIdx = pageStart + i;
        return `<div class="browse-item ${realIdx === selectedIndex ? 'selected' : ''}" data-index="${realIdx}">
            <div class="browse-num">${realIdx + 1}</div>
            <div class="browse-info">
                <div class="browse-song-title">${esc(s.title)}</div>
                <div class="browse-song-artist">${esc(s.artist || '')}</div>
            </div>
        </div>`;
    }).join('');

    // Scroll counter
    const counter = document.getElementById('browseCounter');
    if (counter) {
        counter.textContent = `${selectedIndex + 1} / ${filteredSongs.length}`;
    }
}

// --- Browse queue sidebar ---
async function renderBrowseQueue() {
    const items = await getQueueWaiting(5);
    const el = document.getElementById('browseQueue');
    if (!items.length) {
        el.innerHTML = '<div class="browse-queue-empty">Очередь пуста<div class="browse-queue-empty-hint">Сканируйте QR чтобы выбрать песню</div></div>';
        return;
    }
    el.innerHTML = items.map((item, i) => {
        const title = item.karaoke_songs?.title || '—';
        const artist = item.karaoke_songs?.artist || '';
        const singer = item.user_name || '';
        return `<div class="browse-queue-item">
            <span class="browse-queue-pos">${i + 1}.</span>
            <span class="browse-queue-song">${esc(artist)} — ${esc(title)}</span>
            ${singer ? `<span class="browse-queue-singer">${esc(singer)}</span>` : ''}
        </div>`;
    }).join('');
}

// --- Keyboard navigation (TV remote D-pad) ---
function handleKey(e) {
    if (!visible) return;

    switch (e.key) {
        case 'ArrowUp':
            e.preventDefault();
            if (selectedIndex > 0) {
                selectedIndex--;
                renderList();
            }
            break;

        case 'ArrowDown':
            e.preventDefault();
            if (selectedIndex < filteredSongs.length - 1) {
                selectedIndex++;
                renderList();
            }
            break;

        case 'Enter':
            e.preventDefault();
            selectSong();
            break;
    }
}

// --- Select song ---
async function selectSong() {
    if (!filteredSongs[selectedIndex]) return;
    const song = filteredSongs[selectedIndex];

    // Add to queue and trigger playback
    await addSongToQueue(song.id, 'Зал');
    renderBrowseQueue();

    if (onPlay) onPlay();
}

// --- QR Code ---
function generateQrCode() {
    const remoteUrl = new URL('remote.html', window.location.href);
    remoteUrl.searchParams.set('room', ROOM_ID);

    const container = document.getElementById('browseQr');
    if (!container) return;

    // Use qrcode-generator library (loaded via script tag)
    if (typeof qrcode !== 'undefined') {
        const qr = qrcode(0, 'M');
        qr.addData(remoteUrl.toString());
        qr.make();
        container.innerHTML = qr.createSvgTag(3, 0);
    } else {
        // Fallback: show URL as text
        container.innerHTML = `<div class="qr-fallback">${remoteUrl.toString()}</div>`;
    }

    const label = document.getElementById('browseQrLabel');
    if (label) label.textContent = `Комната: ${ROOM_ID}`;
}

// --- Refresh (called from outside when queue changes) ---
export function refreshBrowseQueue() {
    if (visible) renderBrowseQueue();
}

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}
