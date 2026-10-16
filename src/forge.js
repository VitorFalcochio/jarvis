// Tela cheia da Fábrica de Hologramas: carrega o modelo, lista as peças por grupo, mostra o cartão da peça
// selecionada e obedece aos comandos de voz (desmonta, monta, isola, corte, anima, foca...).
import { createForge, norm } from './forge-engine.js';

const J = window.jarvis;
const $ = (id) => document.getElementById(id);
const root = $('forge');
const info = $('fgInfo');
const label = $('fgLabel');
const strokeEl = $('fgStroke');
let engine = null;
let strokeTimer = 0;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

function report() {
  if (!engine || root.hidden) { J.forgeState({ active: false }); return; }
  const s = engine.selected;
  J.forgeState({ active: true, model: engine.model?.nome, selected: s, explode: engine.explode > 0.3, playing: engine.playing });
}

function showInfo(p) {
  info.innerHTML = '';
  info.classList.toggle('show', !!p);
  document.querySelectorAll('.fg-part').forEach((b) => b.classList.toggle('on', b.dataset.id === p?.id));
  if (!p) { report(); return; }
  const body = el('div', 'doc-aside-body');
  body.append(el('span', 'doc-aside-kicker', `PEÇA · ${(p.grupo || '').toUpperCase()}`), el('h3', '', p.nome));
  if (p.info) body.appendChild(el('p', 'fg-info-text', p.info));
  body.appendChild(el('span', 'doc-aside-src', 'arraste para mover · duplo clique isola · “o que essa peça faz?”'));
  info.appendChild(body);
  report();
}

function buildPartsList() {
  const box = $('fgParts');
  box.innerHTML = '';
  const groups = new Map();
  engine.parts.forEach((p) => { if (!groups.has(p.grupo || 'Peças')) groups.set(p.grupo || 'Peças', []); groups.get(p.grupo || 'Peças').push(p); });
  box.appendChild(el('div', 'fg-parts-title', `${engine.parts.length} PEÇAS`));
  for (const [g, list] of groups) {
    const head = el('button', 'fg-group', `${g} · ${list.length}`);
    head.type = 'button';
    head.title = 'Isolar este grupo';
    head.addEventListener('click', () => { engine.isolate(g); showInfo(null); });
    box.appendChild(head);
    const items = el('div', 'fg-items');
    list.forEach((p) => {
      const b = el('button', 'fg-part', p.nome);
      b.type = 'button';
      b.dataset.id = p.id;
      b.addEventListener('click', () => { engine.select(p.id); });
      items.appendChild(b);
    });
    box.appendChild(items);
  }
}

// legenda do ciclo de 4 tempos (motores): mostra o tempo do cilindro de referência
function tickStroke() {
  const ref = engine?.model?.ciclo_referencia;
  const s = ref && engine.strokeOf(ref);
  strokeEl.textContent = s ? `CILINDRO ${ref.split('_').pop()} · ${s.toUpperCase()}` : '';
  strokeEl.classList.toggle('on', !!s && engine.playing);
}

function open(model) {
  if (!engine) {
    engine = createForge($('forgeCanvas'), {
      onSelect: showInfo,
      onHover: (h) => {
        label.classList.toggle('on', !!h);
        if (h) { label.textContent = h.nome; label.style.left = `${h.x + 16}px`; label.style.top = `${h.y + 12}px`; }
      },
    });
  }
  root.hidden = false;
  root.classList.remove('closing');
  const r = engine.load(model);
  $('fgTitle').textContent = model.nome || '';
  $('fgSub').textContent = model.subtitulo || '';
  $('fgExplode').value = 0;
  $('fgSpeed').value = 1;
  $('fgPlay').textContent = engine.playing ? '❚❚' : '▶';
  $('fgCut').classList.remove('on');
  buildPartsList();
  showInfo(null);
  engine.start();
  clearInterval(strokeTimer);
  strokeTimer = setInterval(tickStroke, 150);
  report();
  return r;
}

function close() {
  if (root.hidden) return;
  root.classList.add('closing');
  clearInterval(strokeTimer);
  setTimeout(() => { root.hidden = true; root.classList.remove('closing'); engine?.stop(); report(); }, 450);
}

// ------------------------------------------------------------ comandos (voz e botões)

function command({ acao, alvo, valor }) {
  if (!engine || root.hidden) return;
  const a = norm(acao);
  if (a === 'explodir' || a === 'desmontar') { engine.setExplode(isFinite(valor) ? Number(valor) : 1); $('fgExplode').value = engine.explode; }
  else if (a === 'montar') { engine.setExplode(0); engine.resetParts(); $('fgExplode').value = 0; }
  else if (a === 'animar') { engine.play(true); $('fgPlay').textContent = '❚❚'; }
  else if (a === 'parar') { engine.play(false); $('fgPlay').textContent = '▶'; }
  else if (a === 'velocidade') { engine.setSpeed(Number(valor) || 1); $('fgSpeed').value = engine.speed; }
  else if (a === 'corte') { $('fgCut').classList.toggle('on', engine.cut(true)); }
  else if (a === 'sem_corte') { $('fgCut').classList.toggle('on', engine.cut(false)); }
  else if (a === 'isolar') { engine.isolate(alvo); showInfo(null); }
  else if (a === 'mostrar_tudo') { engine.isolate(null); }
  else if (a === 'selecionar' || a === 'focar') { engine.select(alvo); }
  else if (a === 'girar') engine.autoRotate(valor !== false && valor !== 0);
  else if (a === 'reset') { engine.reset(); $('fgExplode').value = 0; $('fgCut').classList.remove('on'); showInfo(null); }
  else if (a === 'fechar') close();
  report();
}

root.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fg]');
  if (!b) return;
  const a = b.dataset.fg;
  if (a === 'play') { const on = engine.play(); b.textContent = on ? '❚❚' : '▶'; report(); }
  else if (a === 'cut') b.classList.toggle('on', engine.cut());
  else if (a === 'reset') command({ acao: 'reset' });
  else if (a === 'close') close();
});
$('fgExplode').addEventListener('input', (e) => { engine?.setExplode(Number(e.target.value)); });
$('fgExplode').addEventListener('change', report);
$('fgSpeed').addEventListener('input', (e) => engine?.setSpeed(Number(e.target.value)));

document.addEventListener('keydown', (e) => {
  if (root.hidden || e.target.closest('input[type=text], textarea')) return;
  if (e.code === 'Escape') { if (info.classList.contains('show')) { engine.select(null); engine.isolate(null); } else close(); }
  else if (e.code === 'Space') { e.preventDefault(); $('fgPlay').click(); }
  else if (e.code === 'KeyC') $('fgCut').click();
  else if (e.code === 'KeyR') command({ acao: 'reset' });
  else if (e.code === 'KeyE') command({ acao: engine.explode > 0.3 ? 'montar' : 'explodir' });
});

J.onForge((m) => { if (m.type === 'open') open(m.model); });
J.onForgeCmd(command);
window.forge = { open, close, command, get engine() { return engine; } };
