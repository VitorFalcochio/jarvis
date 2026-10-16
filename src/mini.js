// Mini-orb flutuante: aparece quando a janela principal é minimizada.
const J = window.jarvis;
const canvas = document.getElementById('orb');
const ctx = canvas.getContext('2d');
const bubble = document.getElementById('bubble');

// cores do tema (tokens.css)
const themeCss = getComputedStyle(document.documentElement);
const tok = (name) => themeCss.getPropertyValue(`--${name}-rgb`).split(',').map(Number);
const ACCENT = tok('accent'), IVORY = [255, 246, 230], AMBER = tok('amber'), GREEN = tok('green');
const COLORS = {
  idle: ACCENT, wake: IVORY, loading: [156, 130, 99], listening: IVORY,
  processing: AMBER, thinking: AMBER, searching: AMBER, speaking: ACCENT, offline: tok('red'),
};
let state = 'idle', mic = 0, speak = 0, energy = 0, t = 0, color = [...ACCENT], focus = null;
const mark = new Image();
mark.src = 'assets/mark.svg';

const size = 116 * devicePixelRatio;
canvas.width = canvas.height = size;

function draw() {
  t += 1 / 60;
  color = color.map((v, i) => v + ((COLORS[state] || COLORS.idle)[i] - v) * 0.1);
  let level = 0.08 + Math.sin(t * 1.6) * 0.03;
  if (state === 'listening') level = 0.15 + mic * 0.9;
  else if (speak > 0.02) level = 0.2 + speak * 1.1;
  else if (['thinking', 'processing', 'searching'].includes(state)) level = 0.2 + Math.abs(Math.sin(t * 5)) * 0.15;
  energy += (level - energy) * 0.2;

  const c = size / 2, R = size * 0.26;
  const rgba = (a) => `rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},${a})`;
  ctx.clearRect(0, 0, size, size);

  const glow = ctx.createRadialGradient(c, c, 0, c, c, size / 2);
  glow.addColorStop(0, rgba(0.35 + energy * 0.3));
  glow.addColorStop(1, rgba(0));
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(c, c, size / 2, 0, Math.PI * 2); ctx.fill();

  ctx.lineCap = 'round';
  ctx.strokeStyle = rgba(0.6);
  ctx.lineWidth = 2 * devicePixelRatio;
  for (let i = 0; i < 3; i++) {
    const a = t * (0.6 + energy * 2) + (i * Math.PI * 2) / 3;
    ctx.beginPath(); ctx.arc(c, c, R * 1.5, a, a + 1.1); ctx.stroke();
  }
  // anel do modo foco
  if (focus) {
    const frac = Math.max(0, Math.min(1, (focus.endsAt - Date.now()) / (focus.endsAt - focus.startedAt)));
    const fc = focus.phase === 'focus' ? AMBER : GREEN;
    ctx.strokeStyle = `rgba(${fc.join(',')},0.9)`;
    ctx.beginPath(); ctx.arc(c, c, R * 1.8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ctx.stroke();
  }

  ctx.beginPath();
  for (let i = 0; i <= 80; i++) {
    const a = (i / 80) * Math.PI * 2;
    const r = R + Math.sin(a * 6 + t * 3) * Math.sin(a * 3 - t * 2) * energy * R * 0.4;
    i ? ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r) : ctx.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
  }
  ctx.strokeStyle = rgba(0.95);
  ctx.shadowColor = rgba(1); ctx.shadowBlur = 10 * devicePixelRatio;
  ctx.stroke(); ctx.shadowBlur = 0;

  const core = ctx.createRadialGradient(c, c, 0, c, c, R * 0.9);
  core.addColorStop(0, rgba(0.35 + energy * 0.4));
  core.addColorStop(1, rgba(0));
  ctx.fillStyle = core;
  ctx.beginPath(); ctx.arc(c, c, R * 0.9, 0, Math.PI * 2); ctx.fill();
  // a fita da logo no centro, brilhando com a voz
  if (mark.complete && mark.naturalWidth) {
    const m = R * (1.25 + energy * 0.12);
    ctx.shadowColor = rgba(0.9); ctx.shadowBlur = (6 + energy * 14) * devicePixelRatio;
    ctx.drawImage(mark, c - m / 2, c - m / 2 - R * 0.04, m, m);
    ctx.shadowBlur = 0;
  }

  if (focus) {
    const left = Math.max(0, focus.endsAt - Date.now());
    document.getElementById('focus').textContent = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// Eventos
J.onVoiceStatus(({ state: s }) => { state = s; });
J.onMicLevel((v) => { mic = v; });
J.onSpeakLevel((v) => { speak = v; if (v > 0.02) state = 'speaking'; });
J.onFocus((f) => { focus = f; if (!f) document.getElementById('focus').textContent = ''; });

// Balão com a resposta atual
let text = '', hideTimer;
J.onAiStart(() => { text = ''; });
J.onAiDelta((d) => {
  text += d;
  bubble.textContent = text.trim();
  bubble.classList.toggle('show', !!text.trim());
  clearTimeout(hideTimer);
});
J.onAiDone(() => {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => bubble.classList.remove('show'), 7000);
});

// Cliques só valem em cima do orb; o resto da janela é transparente e deixa passar
canvas.addEventListener('mouseenter', () => J.miniIgnore(false));
canvas.addEventListener('mouseleave', () => { if (!drag) J.miniIgnore(true); });

// Arrastar para mover / clique para falar / duplo clique para abrir
let drag = null, moved = false, clickTimer;
canvas.addEventListener('mousedown', (e) => { drag = { x: e.screenX, y: e.screenY }; moved = false; });
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  moved = true;
  J.miniDrag(dx, dy);
  drag = { x: e.screenX, y: e.screenY };
});
window.addEventListener('mouseup', () => {
  if (drag && moved) J.miniDragEnd();
  drag = null;
});
canvas.addEventListener('click', () => {
  if (moved) return;
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => J.startListening(), 230);
});
canvas.addEventListener('dblclick', () => {
  clearTimeout(clickTimer);
  J.showMain();
});
