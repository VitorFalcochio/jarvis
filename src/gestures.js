// Gestos com a mão (pontos vindos do celular via MediaPipe) → cursor holográfico e ações na interface.
//   pinça rápida ............ clica no que está sob o cursor
//   pinça segurada + mover .. gira o holograma (ou rola a lista sob o cursor)
//   mão aberta + deslizar ... troca de tela (esquerda/direita)
//   mão aberta + subir/descer com holograma aberto ... zoom
//   punho fechado (0,6 s) ... fecha o holograma / painel
(() => {
  const cursor = document.getElementById('handCursor');
  const label = cursor.querySelector('span');
  const badge = document.getElementById('gestureBadge');
  const SCREEN_ORDER = ['hud', 'music', 'projects', 'agenda', 'memory', 'research', 'oficina', 'settings'];

  let pos = null;          // posição suavizada do cursor (px)
  let lastSeen = 0;
  let pinching = false, pinchStart = 0, pinchFrom = null, pinchMoved = 0, lastPinchPos = null;
  let fistSince = 0, cooldownUntil = 0;
  const palmTrail = [];    // posições recentes da palma para detectar deslizar

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  function flash(text) {
    label.textContent = text;
    cursor.classList.add('flash');
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { cursor.classList.remove('flash'); label.textContent = ''; }, 700);
  }

  function hide() {
    cursor.hidden = true;
    badge.hidden = true;
    pinching = false;
    pos = null;
    palmTrail.length = 0;
  }

  // O que está sob o cursor (ignorando o próprio cursor)
  function targetAt(x, y) {
    cursor.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    cursor.style.display = '';
    return el;
  }

  function scrollableAt(el) {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (/(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight) return e;
    }
    return null;
  }

  function click(x, y) {
    const el = targetAt(x, y);
    if (!el) return;
    const clickable = el.closest('button, a, [data-screen], [data-mu], [data-music], li, figure, summary, .rs-cite, .mu-line, canvas, input[type=checkbox]') || el;
    clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    flash('🤏');
  }

  function onHand({ lm, mirror }) {
    if (!lm) { hide(); return; }
    lastSeen = performance.now();
    badge.hidden = false;
    cursor.hidden = false;

    const size = dist(lm[0], lm[9]) || 0.1; // tamanho da mão (pulso → base do dedo médio)
    const extended = [[8, 6], [12, 10], [16, 14], [20, 18]].map(([tip, pip]) => dist(lm[tip], lm[0]) > dist(lm[pip], lm[0]) * 1.12);
    const openPalm = extended.every(Boolean);
    const fist = !extended.some(Boolean);
    const pinchRatio = dist(lm[4], lm[8]) / size;
    const pinchNow = pinching ? pinchRatio < 0.55 : pinchRatio < 0.35; // histerese: não fica "piscando"

    // Ponto de controle: entre polegar e indicador (estável durante a pinça)
    let nx = (lm[4][0] + lm[8][0]) / 2, ny = (lm[4][1] + lm[8][1]) / 2;
    if (mirror) nx = 1 - nx;
    // a área útil é o miolo da imagem: não precisa esticar o braço até a borda
    const tx = Math.min(1, Math.max(0, (nx - 0.15) / 0.7)) * innerWidth;
    const ty = Math.min(1, Math.max(0, (ny - 0.15) / 0.7)) * innerHeight;
    pos = pos ? { x: pos.x + (tx - pos.x) * 0.4, y: pos.y + (ty - pos.y) * 0.4 } : { x: tx, y: ty };
    cursor.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    cursor.classList.toggle('pinch', pinchNow);
    cursor.classList.toggle('palm', openPalm && !pinchNow);
    const now = performance.now();

    // ---- pinça
    if (pinchNow && !pinching) { pinching = true; pinchStart = now; pinchFrom = { ...pos }; lastPinchPos = { ...pos }; pinchMoved = 0; }
    if (pinchNow && pinching) {
      const dx = pos.x - lastPinchPos.x, dy = pos.y - lastPinchPos.y;
      pinchMoved += Math.abs(dx) + Math.abs(dy);
      if (now - pinchStart > 180) {
        if (window.holo?.active) window.holo.rotate(dx * 0.012, dy * 0.012);
        else {
          const sc = scrollableAt(targetAt(pinchFrom.x, pinchFrom.y));
          if (sc) sc.scrollTop -= dy * 2;
        }
      }
      lastPinchPos = { ...pos };
    }
    if (!pinchNow && pinching) {
      pinching = false;
      if (now - pinchStart < 380 && pinchMoved < 40 && now > cooldownUntil) { click(pos.x, pos.y); cooldownUntil = now + 400; }
    }

    // ---- mão aberta: deslizar troca de tela; com holograma, subir/descer faz zoom
    if (openPalm && !pinchNow) {
      palmTrail.push({ x: nx, y: ny, t: now });
      while (palmTrail.length && now - palmTrail[0].t > 350) palmTrail.shift();
      const first = palmTrail[0];
      if (first && now > cooldownUntil) {
        const dx = nx - first.x, dy = ny - first.y;
        if (Math.abs(dx) > 0.22 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          const i = SCREEN_ORDER.indexOf(typeof currentScreen !== 'undefined' ? currentScreen : 'hud');
          const next = SCREEN_ORDER[(i + (dx > 0 ? 1 : -1) + SCREEN_ORDER.length) % SCREEN_ORDER.length];
          if (typeof go === 'function') go(next);
          flash(dx > 0 ? '👉' : '👈');
          palmTrail.length = 0;
          cooldownUntil = now + 900;
        } else if (window.holo?.active && Math.abs(dy) > 0.03 && Math.abs(dy) > Math.abs(dx)) {
          window.holo.zoom(dy < 0 ? 0.97 : 1.03);
        }
      }
    } else palmTrail.length = 0;

    // ---- punho fechado segurado: fecha
    if (fist && !pinchNow) {
      if (!fistSince) fistSince = now;
      if (now - fistSince > 600 && now > cooldownUntil) {
        if (window.holo?.active) window.holo.close();
        else if (typeof closeBriefing === 'function') closeBriefing();
        flash('✊');
        fistSince = 0;
        cooldownUntil = now + 1000;
      }
    } else fistSince = 0;
  }

  window.jarvis.onHand(onHand);
  // a mão sumiu da câmera sem aviso (celular desconectou): esconde o cursor
  setInterval(() => { if (!cursor.hidden && performance.now() - lastSeen > 1500) hide(); }, 500);
})();
