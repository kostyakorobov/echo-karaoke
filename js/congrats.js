import { launchCongratsFx, stopCongratsFx } from './fx.js';

export function showCongrats(singerName, songTitle, artistName) {
    const emojis = ['🎤', '🔥', '⭐', '🎶', '👏', '🎉'];
    const emojiEl = document.getElementById('congratsEmoji');
    emojiEl.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    emojiEl.style.animation = 'none';
    void emojiEl.offsetHeight;
    emojiEl.style.animation = 'congrats-bounce 0.6s ease';
    document.getElementById('congratsSinger').textContent = singerName || 'Браво!';
    document.getElementById('congratsSong').textContent =
        artistName ? `${artistName} — ${songTitle}` : songTitle;
    document.getElementById('congratsScreen').classList.add('visible');
    document.getElementById('line1').innerHTML = '';
    document.getElementById('singer').innerHTML = '';
    launchCongratsFx();
}

export function hideCongrats() {
    document.getElementById('congratsScreen').classList.remove('visible');
    stopCongratsFx();
}

export function showCountdown(nextSong, nextArtist, nextSinger, currentSingerName) {
    document.getElementById('countdownSong').textContent = nextSong;
    document.getElementById('countdownArtist').textContent = nextArtist;
    document.getElementById('countdownSinger').textContent =
        nextSinger ? `Поёт: ${nextSinger}` : '';
    const handoff = document.getElementById('countdownHandoff');
    if (nextSinger && nextSinger !== currentSingerName) {
        handoff.textContent = `Передай микрофон — ${nextSinger}!`;
    } else {
        handoff.textContent = '';
    }
    document.getElementById('countdownScreen').classList.add('visible');

    let count = 5;
    const numEl = document.getElementById('countdownNumber');
    numEl.textContent = count;
    numEl.style.animation = 'none';
    void numEl.offsetHeight;
    numEl.style.animation = '';

    return new Promise(resolve => {
        const interval = setInterval(() => {
            count--;
            if (count <= 0) {
                clearInterval(interval);
                document.getElementById('countdownScreen').classList.remove('visible');
                resolve();
            } else {
                numEl.textContent = count;
                numEl.style.animation = 'none';
                void numEl.offsetHeight;
                numEl.style.animation = '';
            }
        }, 1000);
    });
}
