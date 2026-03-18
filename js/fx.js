// --- Particles + glow (no AudioContext) ---
let fxCanvas, fxCtx, glowEl;
const particles = [];
const MAX_PARTICLES = 50;
let fxFrame = 0;

export function initFx() {
    fxCanvas = document.getElementById('fxCanvas');
    fxCtx = fxCanvas.getContext('2d');
    glowEl = document.getElementById('reactiveGlow');
    resizeFxCanvas();
    window.addEventListener('resize', resizeFxCanvas);
    requestAnimationFrame(renderFx);
}

function resizeFxCanvas() {
    const rect = fxCanvas.parentElement.getBoundingClientRect();
    fxCanvas.width = rect.width;
    fxCanvas.height = rect.height;
}

function spawnParticle() {
    const w = fxCanvas.width, h = fxCanvas.height;
    particles.push({
        x: w * 0.2 + Math.random() * w * 0.6,
        y: h + 10,
        vx: (Math.random() - 0.5) * 1.2,
        vy: -(0.8 + Math.random() * 1.5),
        size: 2 + Math.random() * 4,
        life: 1,
        decay: 0.004 + Math.random() * 0.006,
        hue: 270 + Math.random() * 60,
    });
}

function renderFx() {
    const w = fxCanvas.width, h = fxCanvas.height;
    fxCtx.clearRect(0, 0, w, h);
    fxFrame++;

    const audio = document.getElementById('audio');
    const isPlaying = audio && !audio.paused && !audio.ended && audio.currentTime > 0;

    if (isPlaying && fxFrame % 3 === 0 && particles.length < MAX_PARTICLES) {
        spawnParticle();
    }

    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vx += (Math.random() - 0.5) * 0.1;
        p.life -= p.decay;

        if (p.life <= 0) { particles.splice(i, 1); continue; }

        const alpha = p.life * 0.5;
        fxCtx.beginPath();
        fxCtx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        fxCtx.fillStyle = `hsla(${p.hue}, 80%, 70%, ${alpha})`;
        fxCtx.fill();

        fxCtx.beginPath();
        fxCtx.arc(p.x, p.y, p.size * p.life * 2.5, 0, Math.PI * 2);
        fxCtx.fillStyle = `hsla(${p.hue}, 80%, 70%, ${alpha * 0.12})`;
        fxCtx.fill();
    }

    const pulse = isPlaying ? 0.12 + Math.sin(fxFrame * 0.03) * 0.04 : 0.06;
    glowEl.style.setProperty('--glow-opacity', pulse.toFixed(3));

    requestAnimationFrame(renderFx);
}

// --- Congrats FX: confetti burst + emoji rain ---
let congratsCanvas, cCtx;
let congratsFx = [];
let congratsRunning = false;

export function initCongratsFx() {
    congratsCanvas = document.getElementById('congratsCanvas');
    cCtx = congratsCanvas.getContext('2d');
}

function resizeCongratsCanvas() {
    const rect = congratsCanvas.parentElement.getBoundingClientRect();
    congratsCanvas.width = rect.width;
    congratsCanvas.height = rect.height;
}

function spawnConfetti(w, h) {
    const colors = ['#a855f7', '#ec4899', '#f59e0b', '#22c55e', '#3b82f6', '#ef4444', '#fff'];
    for (let i = 0; i < 80; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 3 + Math.random() * 8;
        congratsFx.push({
            type: 'confetti', x: w / 2, y: h / 2,
            vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 3,
            size: 4 + Math.random() * 6,
            color: colors[Math.floor(Math.random() * colors.length)],
            rotation: Math.random() * 360, rotSpeed: (Math.random() - 0.5) * 15,
            life: 1, decay: 0.008 + Math.random() * 0.005,
        });
    }
}

function spawnEmojiRain(w, h) {
    const emojiSet = ['🎤', '🎵', '🔥', '⭐', '👏', '🎶', '✨', '💜', '🎉', '🎊'];
    for (let i = 0; i < 35; i++) {
        congratsFx.push({
            type: 'emoji',
            x: Math.random() * w, y: -30 - Math.random() * h * 0.8,
            vx: (Math.random() - 0.5) * 0.8, vy: 1.5 + Math.random() * 2.5,
            char: emojiSet[Math.floor(Math.random() * emojiSet.length)],
            size: 20 + Math.random() * 20,
            wobble: Math.random() * Math.PI * 2, wobbleSpeed: 0.02 + Math.random() * 0.03,
            life: 1, decay: 0.003 + Math.random() * 0.003,
        });
    }
}

function renderCongratsFx() {
    if (!congratsRunning) return;
    const w = congratsCanvas.width, h = congratsCanvas.height;
    cCtx.clearRect(0, 0, w, h);

    for (let i = congratsFx.length - 1; i >= 0; i--) {
        const p = congratsFx[i];
        p.life -= p.decay;
        if (p.life <= 0) { congratsFx.splice(i, 1); continue; }

        if (p.type === 'confetti') {
            p.x += p.vx; p.y += p.vy;
            p.vy += 0.15; p.vx *= 0.99; p.rotation += p.rotSpeed;
            cCtx.save();
            cCtx.translate(p.x, p.y);
            cCtx.rotate(p.rotation * Math.PI / 180);
            cCtx.globalAlpha = p.life;
            cCtx.fillStyle = p.color;
            cCtx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            cCtx.restore();
        } else if (p.type === 'emoji') {
            p.x += p.vx + Math.sin(p.wobble) * 0.5;
            p.y += p.vy; p.wobble += p.wobbleSpeed;
            cCtx.globalAlpha = Math.min(1, p.life * 2);
            cCtx.font = `${p.size}px serif`;
            cCtx.fillText(p.char, p.x, p.y);
        }
    }
    cCtx.globalAlpha = 1;

    if (congratsFx.length > 0) {
        requestAnimationFrame(renderCongratsFx);
    } else {
        congratsRunning = false;
    }
}

export function launchCongratsFx() {
    resizeCongratsCanvas();
    congratsFx = [];
    congratsRunning = true;
    const w = congratsCanvas.width, h = congratsCanvas.height;
    spawnConfetti(w, h);
    setTimeout(() => spawnEmojiRain(w, h), 400);
    requestAnimationFrame(renderCongratsFx);
}

export function stopCongratsFx() {
    congratsRunning = false;
    congratsFx = [];
    if (cCtx && congratsCanvas) {
        cCtx.clearRect(0, 0, congratsCanvas.width, congratsCanvas.height);
    }
}
