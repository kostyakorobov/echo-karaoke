import { WORDS_PER_LINE, INTERLUDE_THRESHOLD, LYRICS_PREVIEW_SECS } from './config.js';

let lines = [];
let allWords = [];
let interludeVisible = false;
let interludeShowTime = 0; // when the interlude overlay appeared

/**
 * Parse words into lines.
 * If song has LRC line breaks (gap > 0.8s between words), use those as phrase boundaries.
 * Otherwise fall back to WORDS_PER_LINE chunks.
 * Words with `backing: true` flag are back-vocals.
 */
export function parseWords(song) {
    const words = (song.lyrics || []).filter(w => w.word && w.word.length < 20);
    allWords = words;
    lines = [];

    if (words.length === 0) return { lines, allWords };

    // Check if words have line_break markers (from LRC-based pipeline v4)
    const hasLineBreaks = words.some(w => w.line_break);

    let currentLine = [words[0]];

    if (hasLineBreaks) {
        // Use LRC line structure — each line_break:true marks end of a phrase
        for (let i = 1; i < words.length; i++) {
            if (words[i - 1].line_break) {
                lines.push(currentLine);
                currentLine = [words[i]];
            } else {
                currentLine.push(words[i]);
            }
        }
    } else {
        // Fallback: detect phrase boundaries by timing gaps (old tracks)
        const LINE_GAP = 0.8;
        const MAX_WORDS = 10;
        for (let i = 1; i < words.length; i++) {
            const gap = words[i].start - words[i - 1].end;
            if (gap > LINE_GAP || currentLine.length >= MAX_WORDS) {
                lines.push(currentLine);
                currentLine = [words[i]];
            } else {
                currentLine.push(words[i]);
            }
        }
    }

    if (currentLine.length > 0) {
        lines.push(currentLine);
    }

    return { lines, allWords };
}

export function clearLyrics() {
    lines = [];
    allWords = [];
    interludeVisible = false;
}

export function getLines() { return lines; }
export function getAllWords() { return allWords; }
export function isInterludeVisible() { return interludeVisible; }

export function renderLine(el, lineWords, t) {
    el.innerHTML = '';
    if (!lineWords) return;
    lineWords.forEach(w => {
        const span = document.createElement('span');
        span.className = 'word';
        if (w.backing) span.classList.add('backing');
        span.textContent = w.word + ' ';
        if (t >= w.end) {
            span.classList.add('sung');
        } else if (t >= w.start) {
            span.classList.add('now');
            const progress = Math.min(1, (t - w.start) / (w.end - w.start));
            span.style.setProperty('--fill', (progress * 100) + '%');
            span.style.setProperty('--fill-num', progress.toFixed(2));
        }
        el.appendChild(span);
    });
}

export function renderNextLine(el, lineWords) {
    el.innerHTML = '';
    if (!lineWords) return;
    lineWords.forEach(w => {
        const span = document.createElement('span');
        span.textContent = w.word + ' ';
        if (w.backing) {
            span.style.fontStyle = 'italic';
            span.style.fontSize = '0.8em';
        }
        el.appendChild(span);
    });
}

export function findCurrentLineIdx(t) {
    for (let i = lines.length - 1; i >= 0; i--) {
        if (t >= lines[i][0].start - 0.6) {
            // Don't switch if previous line's last word is still being sung
            if (i > 0) {
                const prevLastWord = lines[i - 1][lines[i - 1].length - 1];
                if (t < prevLastWord.end) return i - 1;
            }
            return i;
        }
    }
    return 0;
}

// --- Interlude detection ---

function findGap(t) {
    if (allWords.length === 0) return null;
    if (t < allWords[0].start) {
        return { gapStart: 0, nextWordStart: allWords[0].start, gapTotal: allWords[0].start, betweenLines: true };
    }
    for (let i = 0; i < allWords.length - 1; i++) {
        if (t >= allWords[i].end && t < allWords[i + 1].start) {
            const gs = allWords[i].end;
            const ns = allWords[i + 1].start;
            // Gap between lines (line_break) vs gap within a line (mid-line pause)
            const betweenLines = !!allWords[i].line_break;
            return { gapStart: gs, nextWordStart: ns, gapTotal: ns - gs, betweenLines };
        }
    }
    return null;
}

export function updateInterlude(t, audioPaused) {
    if (allWords.length === 0) {
        if (interludeVisible) hideInterlude();
        return;
    }
    if (audioPaused) return;

    const gap = findGap(t);
    if (!gap || gap.gapTotal < INTERLUDE_THRESHOLD) {
        if (interludeVisible) hideInterlude();
        return;
    }

    // Safety net: mid-line gaps (no line_break) skip interlude.
    // Pipeline splits these in data, but this protects old/unprocessed tracks.
    if (!gap.betweenLines) {
        if (interludeVisible) hideInterlude();
        return;
    }


    const secsLeft = gap.nextWordStart - t;
    if (secsLeft < 0.5) {
        if (interludeVisible) hideInterlude();
        return;
    }

    const el = document.getElementById('interlude');
    const timer = document.getElementById('interludeTimer');
    const ring = document.getElementById('interludeRing');
    const countdown = document.getElementById('interludeCountdown');
    const line1 = document.getElementById('line1');
    const line2 = document.getElementById('line2');

    // Progress from when overlay appeared (not from gap start, which may be earlier)
    const visibleDuration = gap.nextWordStart - interludeShowTime;
    const visibleElapsed = t - interludeShowTime;
    const progress = visibleDuration > 0 ? Math.min(1, visibleElapsed / visibleDuration) : 0;
    ring.style.strokeDashoffset = (440 * (1 - progress)).toFixed(0);

    timer.textContent = Math.ceil(secsLeft);

    const ringEl = document.querySelector('.interlude-ring');
    if (secsLeft <= 5.5 && secsLeft > 0.5) {
        countdown.textContent = Math.ceil(secsLeft - 0.5);
        countdown.classList.add('visible');
        ringEl.classList.add('fade-out');
        timer.style.opacity = '0';
    } else {
        countdown.classList.remove('visible');
        ringEl.classList.remove('fade-out');
        timer.style.opacity = '1';
    }

    const line0 = document.getElementById('line0');
    // If gap is within a line (mid-line pause like instrumental break),
    // show the countdown but keep lyrics visible so the singer doesn't lose their place
    if (gap.betweenLines) {
        if (secsLeft > LYRICS_PREVIEW_SECS) {
            line0.style.opacity = '0';
            line1.style.opacity = '0';
            line2.style.opacity = '0';
        } else {
            line0.style.opacity = '';
            line1.style.opacity = '1';
            line2.style.opacity = '';
        }
    }
    // Mid-line gap: keep lyrics visible, just show the countdown overlay

    if (!interludeVisible) {
        interludeShowTime = t;
        ring.style.strokeDashoffset = '440';
        el.classList.add('visible');
        interludeVisible = true;
    }
}

export function hideInterlude() {
    document.getElementById('interlude').classList.remove('visible');
    document.getElementById('interludeCountdown').classList.remove('visible');
    document.getElementById('interludeRing').style.strokeDashoffset = '440';
    document.getElementById('line0').style.opacity = '';
    document.getElementById('line1').style.opacity = '1';
    document.getElementById('line2').style.opacity = '';
    interludeVisible = false;
}
