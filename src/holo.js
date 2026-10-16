// Painel de holograma do HUD (usa o motor de holo-engine.js)
import { createHolo } from './holo-engine.js';

const box = document.getElementById('holo');
const canvas = document.getElementById('holoCanvas');
let engine = null;

function open(name) {
  if (!engine) engine = createHolo(canvas);
  document.getElementById('holoTitle').textContent = engine.setModel(name);
  box.hidden = false;
  box.classList.remove('closing');
  engine.start();
}

function close() {
  if (box.hidden) return;
  box.classList.add('closing');
  setTimeout(() => { box.hidden = true; engine?.stop(); }, 300);
}

document.getElementById('holoClose').addEventListener('click', close);

window.holo = {
  open, close,
  rotate: (dx, dy) => engine?.rotate(dx, dy),
  zoom: (f) => engine?.zoom(f),
  get active() { return !box.hidden; },
};
window.jarvis.onHologram(({ model: m }) => open(m));
window.jarvis.onHologramClose(close);
