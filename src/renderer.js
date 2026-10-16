const $ = (id) => document.getElementById(id);
const J = window.jarvis;

// ------------------------------------------------------------ estado

const STATUS_TEXT = {
  loading: 'CARREGANDO', idle: 'EM ESPERA', wake: 'À SUA DISPOSIÇÃO', listening: 'OUVINDO',
  processing: 'PROCESSANDO', thinking: 'PENSANDO', searching: 'CONSULTANDO', speaking: 'FALANDO', offline: 'VOZ OFFLINE',
};
let state = 'loading';
let micLevel = 0;
let speakLevel = 0;

function setState(s, message) {
  state = s;
  const el = $('status');
  el.textContent = message && s === 'loading' ? message.toUpperCase() : STATUS_TEXT[s] || s.toUpperCase();
  el.className = 'status ' + s;
}

// ------------------------------------------------------------ boot

const bootLines = [
  'Inicializando núcleo neural...', 'Conectando ao Nemotron (NVIDIA)...', 'Calibrando sensores de áudio...',
  'Carregando protocolos de personalidade...', 'Todos os sistemas operacionais.',
];
bootLines.forEach((line, i) => setTimeout(() => { $('bootLog').innerHTML += line + '<br>'; }, 350 * i));
setTimeout(() => $('boot').classList.add('done'), 2500);

// ------------------------------------------------------------ orb

const canvas = $('orb');
const ctx = canvas.getContext('2d');
// cores do tema (tokens.css): o canvas não entende var(--...), então lê os valores uma vez
const themeCss = getComputedStyle(document.documentElement);
const tok = (name) => themeCss.getPropertyValue(`--${name}-rgb`).split(',').map(Number);
const ACCENT = tok('accent'), IVORY = [255, 246, 230], AMBER = tok('amber'), GREEN = tok('green'), RED = tok('red');
const COLORS = {
  idle: ACCENT, wake: IVORY, loading: [156, 130, 99], listening: IVORY,
  processing: AMBER, thinking: AMBER, searching: AMBER,
  speaking: ACCENT, offline: RED,
};
let color = [...ACCENT];
const orbMark = new Image();
orbMark.src = 'assets/mark.svg';
let t = 0;
let energy = 0;

function resize() {
  const r = canvas.getBoundingClientRect();
  canvas.width = r.width * devicePixelRatio;
  canvas.height = r.height * devicePixelRatio;
}
window.addEventListener('resize', resize);
resize();

function rgba(c, a) { return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`; }

function draw() {
  t += 1 / 60;
  const target = COLORS[state] || COLORS.idle;
  color = color.map((v, i) => v + (target[i] - v) * 0.08);

  let level = 0.08 + Math.sin(t * 1.6) * 0.03;
  if (state === 'listening') level = 0.15 + micLevel * 0.9;
  else if (state === 'speaking') level = 0.2 + speakLevel * 1.1;
  else if (['thinking', 'processing', 'searching'].includes(state)) level = 0.2 + Math.abs(Math.sin(t * 5)) * 0.15;
  energy += (level - energy) * 0.18;

  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2;
  // Raio base: o anel mais externo (modo foco, R * 1.72) precisa caber no canvas
  const R = Math.min(w, h) * 0.27;
  ctx.clearRect(0, 0, w, h);

  // brilho de fundo
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.9);
  glow.addColorStop(0, rgba(color, 0.22 + energy * 0.3));
  glow.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // anéis girando
  const rings = [
    { r: 1.45, speed: 0.25, segs: 3, len: 0.7, width: 2 },
    { r: 1.28, speed: -0.45, segs: 6, len: 0.35, width: 4 },
    { r: 1.12, speed: 0.8, segs: 2, len: 1.2, width: 1.5 },
    { r: 1.62, speed: -0.12, segs: 40, len: 0.04, width: 6 },
  ];
  ctx.lineCap = 'round';
  for (const ring of rings) {
    const rr = R * ring.r * (1 + energy * 0.12);
    ctx.strokeStyle = rgba(color, 0.45 + energy * 0.4);
    ctx.lineWidth = ring.width * devicePixelRatio;
    for (let i = 0; i < ring.segs; i++) {
      const a = t * ring.speed * (1 + energy * 2) + (i * Math.PI * 2) / ring.segs;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, a, a + ring.len);
      ctx.stroke();
    }
  }

  // forma de onda ao redor do núcleo
  ctx.beginPath();
  const pts = 120;
  for (let i = 0; i <= pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const wave = Math.sin(a * 6 + t * 3) * Math.sin(a * 3 - t * 2) * energy * R * 0.35;
    const r = R * 0.92 + wave;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = rgba(color, 0.9);
  ctx.lineWidth = 2 * devicePixelRatio;
  ctx.shadowColor = rgba(color, 1);
  ctx.shadowBlur = 18 * devicePixelRatio;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // núcleo: brilho suave e a fita da logo, que reage à voz
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.85);
  core.addColorStop(0, rgba(color, 0.3 + energy * 0.45));
  core.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.85, 0, Math.PI * 2);
  ctx.fill();
  if (orbMark.complete && orbMark.naturalWidth) {
    const m = R * (1.3 + energy * 0.12);
    ctx.shadowColor = rgba(color, 0.9);
    ctx.shadowBlur = (8 + energy * 26) * devicePixelRatio;
    ctx.drawImage(orbMark, cx - m / 2, cy - m / 2 - R * 0.04, m, m);
    ctx.shadowBlur = 0;
  }

  // modo foco: arco dourado (foco) ou verde (pausa) com o tempo restante
  if (focus) {
    const total = focus.endsAt - focus.startedAt;
    const frac = Math.max(0, Math.min(1, (focus.endsAt - Date.now()) / total));
    const rr = R * 1.72;
    ctx.lineWidth = 3 * devicePixelRatio;
    ctx.strokeStyle = rgba(AMBER, 0.15);
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = rgba(focus.phase === 'focus' ? AMBER : GREEN, 0.9);
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 12 * devicePixelRatio;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

canvas.addEventListener('click', () => {
  if (state === 'speaking' || state === 'thinking') { stopSpeaking(); J.stop(); return; }
  J.startListening();
});

// ------------------------------------------------------------ áudio (TTS)

const audioCtx = new AudioContext();
const analyser = audioCtx.createAnalyser();
analyser.fftSize = 256;
analyser.connect(audioCtx.destination);
const freq = new Uint8Array(analyser.frequencyBinCount);

// Efeito "voz de IA" (como no filme): corta graves, realça a presença, um chorus metálico curto
// e uma reverberação de sala pequena, misturados por baixo da voz original
let voiceFxEnabled = true;
J.getConfig().then((c) => { voiceFxEnabled = c.voiceFx !== false; });
// Monta o efeito num contexto qualquer (o do PC, ao vivo, ou um OfflineAudioContext para a mensagem de voz do Telegram)
function makeVoiceFx(audioCtx, analyser) {
  const input = audioCtx.createGain();
  const hp = audioCtx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 140;
  const presence = audioCtx.createBiquadFilter();
  presence.type = 'peaking'; presence.frequency.value = 2800; presence.Q.value = 0.9; presence.gain.value = 4;
  const dry = audioCtx.createGain(); dry.gain.value = 0.9;
  const delay = audioCtx.createDelay(0.1); delay.delayTime.value = 0.017;
  const feedback = audioCtx.createGain(); feedback.gain.value = 0.28;
  const wet = audioCtx.createGain(); wet.gain.value = 0.2;
  const reverb = audioCtx.createConvolver();
  const len = Math.floor(audioCtx.sampleRate * 0.45);
  const impulse = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = impulse.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  reverb.buffer = impulse;
  const reverbGain = audioCtx.createGain(); reverbGain.gain.value = 0.1;
  input.connect(hp).connect(presence);
  presence.connect(dry).connect(analyser);
  presence.connect(delay).connect(wet).connect(analyser);
  delay.connect(feedback).connect(delay);
  presence.connect(reverb).connect(reverbGain).connect(analyser);
  return input;
}
const voiceFx = makeVoiceFx(audioCtx, analyser);

// Mensagem de voz do Telegram: aplica o mesmo efeito offline e devolve PCM 16 bits, 48 kHz, mono (o Python vira OGG/Opus)
J.onFxRender(async ({ id, data }) => {
  try {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const src = await audioCtx.decodeAudioData(bytes.buffer);
    const rate = 48000;
    const off = new OfflineAudioContext(1, Math.ceil((src.duration + 0.5) * rate), rate);
    const node = off.createBufferSource();
    node.buffer = src;
    node.connect(voiceFxEnabled ? makeVoiceFx(off, off.destination) : off.destination);
    node.start();
    const out = (await off.startRendering()).getChannelData(0);
    const pcm = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) pcm[i] = Math.max(-1, Math.min(1, out[i] * 0.95)) * 32767;
    let bin = '';
    const u8 = new Uint8Array(pcm.buffer);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    J.fxResult({ id, pcm: btoa(bin) });
  } catch (e) {
    J.fxResult({ id, error: e.message });
  }
});

// Som de abertura: varredura grave subindo + acorde suave
function bootSound() {
  try {
    const t = audioCtx.currentTime;
    const master = audioCtx.createGain();
    master.gain.setValueAtTime(0.0001, t);
    master.gain.exponentialRampToValueAtTime(0.09, t + 0.4);
    master.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    master.connect(audioCtx.destination);
    const sweep = audioCtx.createOscillator();
    sweep.type = 'sawtooth';
    sweep.frequency.setValueAtTime(55, t);
    sweep.frequency.exponentialRampToValueAtTime(440, t + 1.6);
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(300, t); lp.frequency.exponentialRampToValueAtTime(2400, t + 1.6);
    sweep.connect(lp).connect(master);
    sweep.start(t); sweep.stop(t + 2.6);
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + 1.5 + i * 0.08);
      g.gain.exponentialRampToValueAtTime(0.05, t + 1.6 + i * 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + 1.5); o.stop(t + 3.3);
    });
  } catch {}
}
bootSound();

const pending = new Map(); // id -> { data | null }
let nextId = null;
let playing = null;
let aiDone = false;
let followUp = false;

J.onTtsExpect(({ id }) => {
  if (nextId === null) nextId = id;
  pending.set(id, null);
});

J.onTtsAudio(({ id, data }) => {
  if (!pending.has(id)) return;
  pending.set(id, data || '');
  pump();
});

const DECODING = { stop() {} }; // marcador: próxima frase decodificando
let speechGen = 0; // muda a cada interrupção, para descartar decodificações antigas

async function pump() {
  if (playing || nextId === null) return;
  const data = pending.get(nextId);
  if (data === undefined) { nextId = null; checkFinished(); return; }
  if (data === null) return; // ainda sintetizando

  pending.delete(nextId);
  nextId = pending.size ? Math.min(...pending.keys()) : null;
  if (!data) { pump(); return; }

  // Enquanto decodifica, a frase ainda conta como "tocando": senão a fila parece vazia
  // por um instante e o fim da fala seria anunciado antes da última frase tocar
  const gen = speechGen;
  playing = DECODING;
  try {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const buffer = await audioCtx.decodeAudioData(bytes.buffer);
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (gen !== speechGen) return; // a fala foi interrompida durante a decodificação
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(voiceFxEnabled ? voiceFx : analyser);
    playing = src;
    setState('speaking');
    J.ttsPlaying(); // o microfone passa a vigiar: dá para interromper falando
    src.onended = () => {
      if (playing === src) playing = null;
      pump();
      checkFinished();
    };
    src.start();
  } catch (e) {
    console.error(e);
    if (gen !== speechGen) return;
    playing = null;
    pump();
    checkFinished();
  }
}

function checkFinished() {
  if (!aiDone || playing || pending.size) return;
  aiDone = false;
  if (followUp) setState('listening');
  J.speechDone(followUp);
}

// Usuário falou por cima: para de falar na hora e mostra que está ouvindo
J.onBargeIn(() => {
  stopSpeaking();
  setState('listening');
});

function stopSpeaking() {
  speechGen++;
  pending.clear();
  nextId = null;
  aiDone = false;
  if (playing) { const p = playing; playing = null; p.onended = null; try { p.stop(); } catch {} }
}

let measureTick = 0;
(function measure() {
  if (playing) {
    analyser.getByteFrequencyData(freq);
    let sum = 0;
    for (let i = 2; i < 40; i++) sum += freq[i];
    speakLevel = sum / (38 * 255);
  } else speakLevel *= 0.9;
  // O mini-orb pulsa junto com a fala (~20 vezes por segundo basta)
  if (++measureTick % 3 === 0 && (playing || speakLevel > 0.01)) J.sendSpeakLevel(speakLevel);
  requestAnimationFrame(measure);
})();

// ------------------------------------------------------------ chat

const chat = $('chat');
let aiBubble = null;
let aiRaw = '';

function addBubble(cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  if (text) el.textContent = text;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function renderAi(el, raw) {
  el.textContent = '';
  // Resposta com várias linhas (comum na tela de Chat): markdown completo, com listas, tabelas e código
  const md = /\n/.test(raw.trim());
  el.classList.toggle('md', md);
  if (md) { renderMarkdown(el, raw.replace(/\[[A-Z_]*(:[^\]]*)?$/, '')); return; }
  const re = /\[([A-Z_]+)(?::([^\]]*))?\]/g;
  let last = 0, m;
  while ((m = re.exec(raw))) {
    mdInline(el, raw.slice(last, m.index));
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = m[2] ? `${m[1]}: ${m[2]}` : m[1];
    el.append(tag);
    last = m.index + m[0].length;
  }
  mdInline(el, raw.slice(last).replace(/\[[A-Z_]*(:[^\]]*)?$/, ''));
}

// Botão discreto de copiar (aparece ao passar o mouse)
function addCopy(el, getText) {
  const b = document.createElement('button');
  b.className = 'copy';
  b.type = 'button';
  b.title = 'Copiar';
  b.textContent = '⧉';
  b.onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(getText()).then(() => {
      b.textContent = '✓';
      setTimeout(() => { b.textContent = '⧉'; }, 1200);
    });
  };
  el.append(b);
}

// Markdown simples montado com DOM (nada de innerHTML: o texto vem do modelo)
function mdInline(parent, text) {
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    parent.append(text.slice(last, m.index));
    const t = m[0];
    let node;
    if (t[0] === '`') { node = document.createElement('code'); node.textContent = t.slice(1, -1); }
    else if (t.startsWith('**')) { node = document.createElement('strong'); node.textContent = t.slice(2, -2); }
    else if (t[0] === '*') { node = document.createElement('em'); node.textContent = t.slice(1, -1); }
    else {
      const [, label, url] = t.match(/\[([^\]]+)\]\(([^)]+)\)/);
      node = document.createElement('a');
      node.textContent = label;
      node.href = '#';
      node.onclick = (e) => { e.preventDefault(); J.openExternal(url); };
    }
    parent.append(node);
    last = m.index + t.length;
  }
  parent.append(text.slice(last));
}

function renderMarkdown(el, text) {
  const parts = text.split(/```([\w-]*)\n?/);
  // split com grupo: [texto, lang, código, texto, lang, código, ...]
  for (let i = 0; i < parts.length; i += 3) {
    renderBlocks(el, parts[i] || '');
    if (i + 2 < parts.length) {
      const lang = parts[i + 1];
      const code = parts[i + 2].replace(/\n$/, '');
      const box = document.createElement('div');
      box.className = 'codebox';
      const head = document.createElement('div');
      head.className = 'codehead';
      head.textContent = lang || 'código';
      addCopy(head, () => code);
      const pre = document.createElement('pre');
      pre.textContent = code;
      box.append(head, pre);
      el.append(box);
    }
  }
}

// Tabela markdown: | a | b | / |---|---| / | 1 | 2 |
function mdTable(lines) {
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const rows = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map(cells);
  const wrap = document.createElement('div');
  wrap.className = 'md-table';
  const table = document.createElement('table');
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    r.forEach((c) => { const td = document.createElement(i === 0 ? 'th' : 'td'); mdInline(td, c); tr.append(td); });
    table.append(tr);
  });
  wrap.append(table);
  return wrap;
}

function renderBlocks(el, text) {
  let list = null;
  let table = null;
  const flushTable = () => { if (table) { el.append(mdTable(table)); table = null; } };
  for (const line of text.split('\n')) {
    if (/^\s*\|.*\|\s*$/.test(line)) { list = null; (table ||= []).push(line); continue; }
    flushTable();
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const li = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)/);
    if (li) {
      const tag = li[1] ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) { list = document.createElement(tag); el.append(list); }
      const item = document.createElement('li');
      mdInline(item, li[2]);
      list.append(item);
      continue;
    }
    list = null;
    if (h) {
      const hd = document.createElement('div');
      hd.className = 'md-h' + h[1].length;
      mdInline(hd, h[2]);
      el.append(hd);
    } else if (line.trim()) {
      const p = document.createElement('p');
      mdInline(p, line);
      el.append(p);
    }
  }
  flushTable();
}

// Passos que o JARVIS está executando, mostrados no chat ("Pesquisando na web… ✓")
const STEP_LABELS = {
  web_search: 'Pesquisando na web', research_deep: 'Pesquisa aprofundada', compare: 'Comparando opções',
  read_link: 'Lendo o link', knowledge_card: 'Consultando fontes', weather: 'Consultando o clima',
  news: 'Buscando notícias', music_play: 'Tocando música', music_control: 'Controlando a música',
  music_now_playing: 'Vendo o que está tocando', memory_remember: 'Guardando na memória',
  task_add: 'Adicionando tarefa', note_add: 'Anotando', reminder_add: 'Criando lembrete',
  show_visual: 'Montando o visual', briefing_show: 'Montando o briefing', focus_start: 'Iniciando o modo foco',
  code_task: 'Acionando agente de código', codex_task: 'Acionando o Codex', look_at_screen: 'Olhando a tela',
  camera_look: 'Olhando pela câmera', map_show: 'Abrindo o mapa', documentary_start: 'Preparando o documentário',
  holo3d_show: 'Montando o modelo 3D', hologram_show: 'Projetando holograma', open_app: 'Abrindo programa',
  window_move: 'Organizando janelas', look_attachment: 'Olhando a imagem', knowledge_read: 'Consultando o dossiê', knowledge_teach: 'Aprendendo',
  project_recap: 'Lembrando onde parou', project_memory_save: 'Anotando no projeto', show_images: 'Buscando fotos', chat_ask: 'Preparando perguntas', clipboard_explain: 'Lendo a área de transferência',
};
const HIDDEN_STEPS = new Set(['show_in_chat', 'offer_choices']);
let stepsBox = null;
const stepRows = new Map();

J.onAiStep(({ id, name, arg, state }) => {
  if (HIDDEN_STEPS.has(name)) return;
  let row = stepRows.get(id);
  if (!row) {
    if (!stepsBox) stepsBox = addBubble('steps');
    row = document.createElement('div');
    row.className = 'step';
    const ic = document.createElement('span');
    ic.className = 'step-ic';
    const label = document.createElement('span');
    label.textContent = STEP_LABELS[name] || name.replace(/_/g, ' ');
    row.append(ic, label);
    if (arg) {
      const small = document.createElement('small');
      small.textContent = arg.length > 60 ? arg.slice(0, 60) + '…' : arg;
      row.append(small);
    }
    stepsBox.append(row);
    stepRows.set(id, row);
    sealAiBubble();
    aiBubble = null; // o texto depois da ferramenta vem num balão novo, abaixo dos passos
  }
  row.dataset.state = state;
  chat.scrollTop = chat.scrollHeight;
});

// Botões de escolha: clicar manda a opção como se o usuário tivesse falado
let choicesBox = null;
function retireChoices() {
  if (!choicesBox) return;
  choicesBox.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  choicesBox.classList.add('used');
  choicesBox = null;
}
J.onAiChoices((options) => {
  retireChoices();
  const box = addBubble('choices');
  options.forEach((opt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opt;
    b.onclick = () => {
      if (b.disabled) return;
      b.classList.add('picked');
      retireChoices();
      audioCtx.resume();
      uiSend(opt, undefined, { button: true });
    };
    box.append(b);
  });
  choicesBox = box;
});

function sealAiBubble() {
  if (!aiBubble) return;
  aiBubble.classList.remove('streaming');
  const raw = aiRaw.trim();
  if (raw && !aiBubble.querySelector('.copy')) addCopy(aiBubble, () => raw);
}

J.onUserMessage((text) => {
  stopSpeaking();
  sealAiBubble();
  retireChoices();
  addBubble('user', text);
  aiBubble = null;
  stepsBox = null;
  stepRows.clear();
});
J.onAiStart(() => { sealAiBubble(); aiBubble = null; aiRaw = ''; });
J.onAiDelta((delta) => {
  if (!aiBubble && !delta.trim()) return; // o modelo às vezes manda só "\n" antes de chamar uma ferramenta
  if (!aiBubble) { aiBubble = addBubble('ai streaming'); aiRaw = ''; }
  aiRaw += delta;
  renderAi(aiBubble, aiRaw.trimStart());
  // os botões de escolha ficam sempre embaixo da resposta
  if (choicesBox) chat.append(choicesBox);
  chat.scrollTop = chat.scrollHeight;
});
// Texto detalhado (código, passos) que aparece no chat sem ser falado
J.onAiNote((text) => {
  const el = addBubble('note');
  renderMarkdown(el, text);
  addCopy(el, () => text);
  chat.scrollTop = chat.scrollHeight;
});

J.onAiDone((opts) => {
  sealAiBubble();
  if (choicesBox) chat.append(choicesBox);
  chat.scrollTop = chat.scrollHeight;
  aiDone = true;
  followUp = !!opts.followUp;
  if (!playing && !pending.size) checkFinished();
});

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  $('text').value = '';
  audioCtx.resume();
  J.sendText(text);
});

$('btnClear').addEventListener('click', async () => {
  await J.clearHistory();
  chat.innerHTML = '';
  toast('Memória da conversa apagada.');
});

J.getHistory().then((h) => {
  h.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() && m.content !== '(feito)')
    .slice(-12)
    .forEach((m) => {
      if (m.role === 'user') addBubble('user', m.content);
      else {
        const el = addBubble('ai');
        renderAi(el, m.content);
        addCopy(el, () => m.content);
      }
    });
});

// ------------------------------------------------------------ status e painéis

J.onVoiceStatus(({ state: s, message }) => {
  if (playing && s !== 'listening') return; // não sobrescreve "falando"
  setState(s, message);
});
J.onMicLevel((v) => { micLevel = v; });
J.getVoiceStatus().then((s) => { if (state === 'loading') setState(s); });

J.onStats(({ cpu, ram, uptime }) => {
  $('cpuVal').textContent = cpu + '%';
  $('ramVal').textContent = ram + '%';
  $('cpuBar').style.width = cpu + '%';
  $('ramBar').style.width = ram + '%';
  $('cpuBar').classList.toggle('hot', cpu > 80);
  $('ramBar').classList.toggle('hot', ram > 85);
  const hrs = Math.floor(uptime / 3600), min = Math.floor((uptime % 3600) / 60);
  $('uptime').textContent = `${hrs}h ${min}min`;
  renderPresence();
});

// Presença na mesa (câmera do celular): "34 min · postura ok" / "fora há 5 min"
let presence = { active: false };
function renderPresence() {
  $('presRow').hidden = !presence.active;
  if (!presence.active) return;
  const mins = (t) => Math.max(0, Math.round((Date.now() - t) / 60000));
  const el = $('presVal');
  if (presence.present === false) { el.textContent = `fora há ${mins(presence.leftAt)} min`; el.className = 'muted'; return; }
  if (!presence.sittingSince) { el.textContent = 'detectando...'; el.className = ''; return; }
  el.textContent = `${mins(presence.sittingSince)} min · postura ${presence.posture === 'bad' ? 'curvada' : 'ok'}`;
  el.className = presence.posture === 'bad' ? 'warn' : '';
}
J.onPresence((p) => { presence = p || { active: false }; renderPresence(); });

J.onWeather(({ city, temp, desc }) => {
  $('weather').innerHTML = '';
  const tEl = document.createElement('div'); tEl.className = 'temp'; tEl.textContent = `${temp}°C`;
  const d = document.createElement('div'); d.textContent = `${city} · ${desc}`;
  $('weather').append(tEl, d);
});

// Agenda = tarefas pendentes + lembretes
let agenda = { tasks: [], reminders: [] };

function renderAgenda() {
  const tasksUl = $('tasks');
  const remUl = $('reminders');
  tasksUl.innerHTML = '';
  remUl.innerHTML = '';
  if (!agenda.tasks.length && !agenda.reminders.length) {
    tasksUl.innerHTML = '<li class="muted">Nada pendente</li>';
    return;
  }
  agenda.tasks.slice(0, 6).forEach((t) => {
    const li = document.createElement('li');
    li.className = 'task';
    li.append(t.text);
    if (t.due) {
      const due = document.createElement('span');
      due.className = 'due';
      due.textContent = new Date(t.due + 'T00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      li.append(due);
    }
    tasksUl.append(li);
  });
  agenda.reminders.slice().sort((a, b) => a.at - b.at).forEach((r) => {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = new Date(r.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    li.append(b, r.text);
    remUl.append(li);
  });
}
J.getReminders().then((r) => { agenda.reminders = r; renderAgenda(); });
J.getTasks().then((t) => { agenda.tasks = t; renderAgenda(); });
J.onReminders((r) => { agenda.reminders = r; renderAgenda(); });
J.onTasks((t) => { agenda.tasks = t; renderAgenda(); });

// ------------------------------------------------------------ modo foco

let focus = null;

J.onFocus((f) => {
  focus = f;
  $('focusBox').hidden = !f;
  $('hint').hidden = !!f;
  if (!f) return;
  $('focusBox').classList.toggle('break', f.phase === 'break');
  $('focusPhase').textContent = f.phase === 'focus' ? 'MODO FOCO' : 'PAUSA';
  $('focusCycles').textContent = Array.from({ length: f.cycles }, (_, i) => (i < f.cycle - (f.phase === 'focus' ? 1 : 0) ? '●' : i === f.cycle - 1 ? '◉' : '○')).join('');
  $('focusTask').textContent = f.task || '';
  tickFocus();
});

function tickFocus() {
  if (!focus) return;
  const left = Math.max(0, focus.endsAt - Date.now());
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  $('focusTime').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
setInterval(tickFocus, 1000);

// ------------------------------------------------------------ briefing

const bf = { timers: [] };

function blip(i) {
  // "bip" holográfico curto a cada card que aparece
  try {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880 + i * 40, audioCtx.currentTime);
    o.frequency.exponentialRampToValueAtTime(1760 + i * 60, audioCtx.currentTime + 0.07);
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.035, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.13);
  } catch {}
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function card(label, cls = '', aside = '') {
  const c = el('article', `bf-card ${cls}`);
  const l = el('div', 'bf-label');
  l.append(el('span', '', label));
  if (aside) l.append(el('span', 'muted', aside));
  c.append(l);
  return c;
}

const brl = (v, digits = 2) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: digits, maximumFractionDigits: digits });

function chip(change) {
  const up = change >= 0;
  return el('span', `bf-chip ${up ? 'up' : 'down'}`, `${up ? '▲' : '▼'} ${Math.abs(change).toFixed(2)}%`);
}

function sparkline(values) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 30');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('bf-spark');
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${27 - ((v - min) / span) * 24}`);
  const area = document.createElementNS(ns, 'path');
  area.setAttribute('d', `M0,30 L${pts.join(' L')} L100,30 Z`);
  area.setAttribute('fill', rgba(ACCENT, 0.12));
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', pts.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', rgba(ACCENT, 1));
  line.setAttribute('stroke-width', '1.6');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(area, line);
  return svg;
}

// Número que "sobe" até o valor final
function countUp(node, to, fmt, ms = 900) {
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / ms);
    node.textContent = fmt(to * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const WEATHER_ICONS = (code) => (code === 0 ? '☀' : code <= 2 ? '⛅' : code <= 48 ? '☁' : code <= 67 || (code >= 80 && code <= 82) ? '🌧' : code >= 95 ? '⛈' : '☁');

function buildBriefing(d) {
  const cards = [];

  if (d.currency) {
    const c = card('DÓLAR', '', 'USD/BRL');
    const big = el('div', 'bf-big');
    const value = el('span', '', brl(0));
    big.append(value, chip(d.currency.usd.change));
    c.append(big);
    if (d.currency.usdWeek?.length > 1) c.append(sparkline(d.currency.usdWeek));
    const sub = el('div', 'bf-sub');
    const eur = el('span'); eur.append('EUR ', el('b', '', brl(d.currency.eur.value)));
    const btc = el('span'); btc.append('BTC ', el('b', '', brl(d.currency.btc.value, 0)));
    sub.append(eur, btc);
    c.append(sub);
    c.onAppear = () => countUp(value, d.currency.usd.value, (v) => brl(v, 4).replace(/0{2}$/, ''));
    cards.push(c);
  }

  if (d.weather) {
    const w = d.weather;
    const c = card('CLIMA', '', w.city.toUpperCase());
    const big = el('div', 'bf-big');
    const temp = el('span', '', '0°');
    big.append(`${WEATHER_ICONS(w.code)} `, temp);
    c.append(big);
    const sub = el('div', 'bf-sub');
    const range = el('span'); range.append('mín ', el('b', '', `${w.min}°`), ' · máx ', el('b', '', `${w.max}°`));
    sub.append(range, el('span', '', `chuva ${w.rain}%`));
    c.append(sub);
    c.onAppear = () => countUp(temp, w.temp, (v) => `${Math.round(v)}°`, 700);
    cards.push(c);
  }

  (d.curiosities || []).slice(0, 2).forEach((cur, i) => {
    const c = card(i === 0 ? 'VOCÊ SABIA?' : 'CURIOSIDADE', 'bf-curio');
    c.append(el('b', '', cur.title), el('p', '', cur.text));
    cards.push(c);
  });

  if (d.news?.length) {
    const c = card('INTELIGÊNCIA ARTIFICIAL', 'span2 tall', 'ÚLTIMAS 24H');
    const ul = el('ul', 'bf-news');
    d.news.forEach((n) => {
      const li = el('li');
      li.append(el('span', '', n.title), el('small', '', n.source));
      li.title = 'Abrir notícia';
      li.onclick = () => n.link && J.openExternal(n.link);
      ul.append(li);
    });
    c.append(ul);
    cards.push(c);
  }

  if (d.history) {
    const c = card('HOJE NA HISTÓRIA', 'span2');
    c.append(el('div', 'bf-year', d.history.year), el('p', 'bf-curio', d.history.text));
    cards.push(c);
  }

  const tc = card('PENDÊNCIAS', 'span2', d.tasks?.length ? `${d.tasks.length}` : '');
  if (d.tasks?.length) {
    const ul = el('ul', 'reminders');
    d.tasks.forEach((t) => { const li = el('li', 'task'); li.append(t.text); ul.append(li); });
    tc.append(ul);
  } else {
    tc.append(el('p', 'muted', 'Nenhuma tarefa pendente. Dia livre para criar algo novo.'));
  }
  cards.push(tc);

  if (d.memes?.length) {
    const c = card('MEMES DO DIA', 'span4', 'REDDIT');
    const grid = el('div', 'bf-memes');
    d.memes.forEach((m) => {
      const fig = el('figure', 'bf-meme');
      const img = el('img');
      img.src = m.image;
      img.alt = m.title;
      img.loading = 'lazy';
      img.onerror = () => fig.remove();
      fig.append(img, el('figcaption', '', `r/${m.sub}`));
      fig.title = m.title;
      fig.onclick = () => J.openExternal(m.link);
      grid.append(fig);
    });
    c.append(grid);
    cards.push(c);
  }

  return cards;
}

// Painel holográfico genérico (briefing, respostas visuais, painel do projeto)
function showPanel({ kicker, title, subtitle, loading }, buildCards) {
  bf.timers.forEach(clearTimeout);
  bf.timers = [];
  const box = $('briefing');
  box.classList.remove('closing');
  box.hidden = false;
  $('bfKicker').textContent = kicker;
  $('bfDate').textContent = title;
  $('bfSubtitle').textContent = subtitle || '';

  const grid = $('bfGrid');
  grid.innerHTML = '';
  $('bfLoading').hidden = !loading;
  if (loading) return;
  const cards = buildCards();
  cards.forEach((c) => grid.append(c));
  // Gráficos precisam da largura real do card, então desenham depois de entrar no DOM
  cards.forEach((c) => c.onMount && c.onMount());
  // Os cards "pipocam" um de cada vez
  cards.forEach((c, i) => {
    bf.timers.push(setTimeout(() => {
      c.classList.add('in');
      blip(i);
      if (c.onAppear) c.onAppear();
    }, 250 + i * 420));
  });
}

function openBriefing(d) {
  showPanel({
    kicker: 'BRIEFING DIÁRIO',
    title: d.date || new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }),
    loading: d.loading,
  }, () => buildBriefing(d));
}

// ------------------------------------------------------------ respostas visuais

// Paleta categórica validada para o fundo de obsidiana (ordem fixa, nunca reciclada).
// O champanhe da marca não entra aqui: tem pouca saturação e "lê como cinza" num gráfico.
const SERIES_COLORS = ['#1a9cc4', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'];
// Escala sequencial (um só tom, do bronze apagado ao champanhe) para o mapa de commits
const HEAT_STEPS = ['rgba(255,255,255,0.06)', '#3b3226', '#6b583f', '#a88b62', '#e9d6b6'];
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function fmtNum(v, unit = '') {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 2 : abs >= 1 ? 2 : 4;
  const n = v.toLocaleString('pt-BR', { maximumFractionDigits: digits });
  if (unit === 'R$') return `R$ ${n}`;
  return unit ? `${n}${unit === '%' ? '%' : ' ' + unit}` : n;
}

// Marcas "redondas" para o eixo: 1, 2, 2,5, 5 × 10^n
function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

// Tooltip compartilhado do painel
function tooltip() {
  let tip = document.getElementById('vizTip');
  if (!tip) {
    tip = el('div', 'viz-tip');
    tip.id = 'vizTip';
    document.body.append(tip);
  }
  return tip;
}
function showTip(x, y, title, rows) {
  const tip = tooltip();
  tip.innerHTML = '';
  tip.append(el('div', 'viz-tip-title', title));
  rows.forEach(({ color, value, label }) => {
    const r = el('div', 'viz-tip-row');
    const sw = el('i');
    if (color) sw.style.background = color;
    r.append(sw, el('b', '', value), el('span', '', label || ''));
    tip.append(r);
  });
  tip.style.display = 'block';
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, x + 14)}px`;
  tip.style.top = `${Math.max(8, y - h - 10)}px`;
}
const hideTip = () => { tooltip().style.display = 'none'; };

function legend(series) {
  const l = el('div', 'viz-legend');
  series.forEach((s, i) => {
    const item = el('span');
    const sw = el('i');
    sw.style.background = SERIES_COLORS[i];
    item.append(sw, s.name);
    l.append(item);
  });
  return l;
}

function drawChart(host, spec) {
  host.innerHTML = '';
  const multi = spec.series.length > 1;
  if (multi) host.append(legend(spec.series));
  const W = Math.max(240, host.clientWidth), H = spec.size === 'large' || !spec.size ? 220 : 170;
  const direct = multi && spec.series.length <= 4 && spec.kind === 'line';
  const M = { l: 52, r: direct ? 86 : 14, t: 10, b: 26 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const all = spec.series.flatMap((s) => s.values).filter((v) => v !== null);
  let min = Math.min(...all), max = Math.max(...all);
  if (spec.kind === 'bar') { min = Math.min(0, min); max = Math.max(0, max); } // barras sempre partem do zero
  let ticks = niceTicks(min, max);
  // Contagens (valores inteiros) não ganham marcas fracionadas como 0,25
  if (all.every(Number.isInteger) && ticks[1] - ticks[0] < 1) {
    ticks = [];
    for (let v = Math.floor(min); v <= Math.max(Math.ceil(max), Math.floor(min) + 1); v++) ticks.push(v);
  }
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const y = (v) => M.t + ih - ((v - y0) / (y1 - y0)) * ih;
  const n = spec.labels.length;

  const svg = svgEl('svg', { width: W, height: H, class: 'viz-svg', role: 'img', 'aria-label': spec.title });
  // grade recessiva + valores do eixo (todos com as mesmas casas decimais do passo)
  const step = ticks[1] - ticks[0];
  const decimals = Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9) + (Number.isInteger(step * 10 ** -Math.floor(Math.log10(step))) ? 0 : 1)));
  ticks.forEach((tv) => {
    svg.append(svgEl('line', { x1: M.l, x2: W - M.r, y1: y(tv), y2: y(tv), class: 'viz-grid' }));
    const tx = svgEl('text', { x: M.l - 8, y: y(tv) + 4, class: 'viz-axis', 'text-anchor': 'end' });
    const n = tv.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    tx.textContent = spec.unit && spec.unit !== 'R$' ? `${n}${spec.unit === '%' ? '%' : ''}` : n;
    svg.append(tx);
  });
  // rótulos do eixo X (no máximo ~7)
  const every = Math.max(1, Math.ceil(n / 7));
  const xLine = (i) => M.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const band = iw / n;
  const xBand = (i) => M.l + i * band + band / 2;
  const xAt = spec.kind === 'bar' ? xBand : xLine;
  spec.labels.forEach((lab, i) => {
    if (i % every && i !== n - 1) return;
    const tx = svgEl('text', { x: xAt(i), y: H - 6, class: 'viz-axis', 'text-anchor': 'middle' });
    tx.textContent = lab;
    svg.append(tx);
  });

  if (spec.kind === 'bar') {
    const k = spec.series.length;
    // barras finas: no máximo 44px cada, com 2px entre barras vizinhas
    const bw = Math.max(2, Math.min(44, (band * 0.72 - (k - 1) * 2) / k));
    const groupW = bw * k + (k - 1) * 2;
    const base = y(0);
    spec.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (v === null) return;
        const x = xBand(i) - groupW / 2 + si * (bw + 2);
        const top = Math.min(y(v), base), h = Math.max(1, Math.abs(y(v) - base));
        const r = Math.min(4, bw / 2, h);
        // topo arredondado (ou a base, para valores negativos), ancorado no zero
        const d = v >= 0
          ? `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z`
          : `M${x},${base} V${top + h - r} Q${x},${top + h} ${x + r},${top + h} H${x + bw - r} Q${x + bw},${top + h} ${x + bw},${top + h - r} V${base} Z`;
        const bar = svgEl('path', { d, fill: SERIES_COLORS[si], class: 'viz-bar', tabindex: 0 });
        const show = (e) => showTip(e.clientX ?? bar.getBoundingClientRect().right, e.clientY ?? bar.getBoundingClientRect().top, spec.labels[i], [{ color: SERIES_COLORS[si], value: fmtNum(v, spec.unit), label: multi ? s.name : '' }]);
        bar.addEventListener('pointermove', show);
        bar.addEventListener('focus', show);
        bar.addEventListener('pointerleave', hideTip);
        bar.addEventListener('blur', hideTip);
        svg.append(bar);
      });
    });
    if (y0 < 0) svg.append(svgEl('line', { x1: M.l, x2: W - M.r, y1: base, y2: base, class: 'viz-zero' }));
  } else {
    spec.series.forEach((s, si) => {
      // quebra a linha onde faltar valor
      let d = '', pen = false;
      s.values.forEach((v, i) => {
        if (v === null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${xLine(i)},${y(v)} `;
        pen = true;
      });
      if (!multi) {
        const first = s.values.findIndex((v) => v !== null);
        const last = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
        svg.append(svgEl('path', { d: `${d} L${xLine(last)},${M.t + ih} L${xLine(first)},${M.t + ih} Z`, fill: SERIES_COLORS[si], opacity: 0.12 }));
      }
      svg.append(svgEl('path', { d, fill: 'none', stroke: SERIES_COLORS[si], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (direct) {
        const li = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
        const tx = svgEl('text', { x: xLine(li) + 8, y: y(s.values[li]) + 4, class: 'viz-direct' });
        tx.textContent = s.name;
        svg.append(tx);
      }
    });
    // crosshair: linha vertical que segue o mouse + tooltip com todas as séries
    const cross = svgEl('line', { y1: M.t, y2: M.t + ih, class: 'viz-cross', visibility: 'hidden' });
    const dots = spec.series.map((_, si) => svgEl('circle', { r: 4, fill: SERIES_COLORS[si], class: 'viz-dot', visibility: 'hidden' }));
    const hit = svgEl('rect', { x: M.l - 6, y: M.t, width: iw + 12, height: ih, fill: 'transparent' });
    svg.append(cross, ...dots, hit);
    hit.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - rect.left - M.l) / iw) * (n - 1))));
      const x = xLine(i);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      spec.series.forEach((s, si) => {
        const v = s.values[i];
        dots[si].setAttribute('visibility', v === null ? 'hidden' : 'visible');
        if (v !== null) { dots[si].setAttribute('cx', x); dots[si].setAttribute('cy', y(v)); }
      });
      showTip(e.clientX, rect.top + y(Math.max(...spec.series.map((s) => s.values[i] ?? -Infinity))), spec.labels[i],
        spec.series.map((s, si) => ({ color: SERIES_COLORS[si], value: fmtNum(s.values[i], spec.unit), label: multi ? s.name : '' })));
    });
    hit.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
      hideTip();
    });
  }
  host.append(svg);
}

function dataTable(columns, rows) {
  const wrap = el('div', 'viz-table-wrap');
  const table = el('table', 'viz-table');
  const tr = el('tr');
  columns.forEach((c) => tr.append(el('th', '', c)));
  const thead = el('thead'); thead.append(tr);
  const tbody = el('tbody');
  rows.forEach((r) => {
    const row = el('tr');
    r.forEach((v) => row.append(el('td', '', v)));
    tbody.append(row);
  });
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function heatmap(host, days) {
  host.innerHTML = '';
  const weeks = Math.ceil(days.length / 7);
  const max = Math.max(1, ...days.map((d) => d.count));
  const level = (c) => (c === 0 ? 0 : Math.min(4, Math.ceil((c / max) * 4)));
  const gap = 3, left = 30, top = 16;
  const cell = Math.max(8, Math.min(22, Math.floor((host.clientWidth - left - weeks * gap) / weeks)));
  const W = left + weeks * (cell + gap), H = top + 7 * (cell + gap);
  const svg = svgEl('svg', { width: W, height: H, class: 'viz-svg' });
  ['', 'seg', '', 'qua', '', 'sex', ''].forEach((d, i) => {
    if (!d) return;
    const tx = svgEl('text', { x: left - 6, y: top + i * (cell + gap) + cell - 2, class: 'viz-axis', 'text-anchor': 'end' });
    tx.textContent = d;
    svg.append(tx);
  });
  let lastMonth = '';
  days.forEach((d, i) => {
    const w = Math.floor(i / 7), dow = i % 7;
    const date = new Date(d.date + 'T00:00');
    const month = date.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
    if (dow === 0 && month !== lastMonth) {
      const tx = svgEl('text', { x: left + w * (cell + gap), y: 10, class: 'viz-axis' });
      tx.textContent = month;
      svg.append(tx);
      lastMonth = month;
    }
    const rect = svgEl('rect', { x: left + w * (cell + gap), y: top + dow * (cell + gap), width: cell, height: cell, rx: 2, fill: HEAT_STEPS[level(d.count)], tabindex: 0, class: 'viz-cell' });
    const show = (e) => {
      const r = rect.getBoundingClientRect();
      showTip(e.clientX ?? r.right, e.clientY ?? r.top, date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }),
        [{ value: String(d.count), label: d.count === 1 ? 'commit' : 'commits' }]);
    };
    rect.addEventListener('pointermove', show);
    rect.addEventListener('focus', show);
    rect.addEventListener('pointerleave', hideTip);
    rect.addEventListener('blur', hideTip);
    svg.append(rect);
  });
  host.append(svg);
  const key = el('div', 'viz-heat-key');
  key.append('menos');
  HEAT_STEPS.forEach((c) => { const i = el('i'); i.style.background = c; key.append(i); });
  key.append('mais');
  host.append(key);
}

const SIZE_CLASS = { small: '', medium: 'span2', large: 'span4' };
const DEFAULT_SIZE = { stat: 'small', chart: 'large', table: 'large', list: 'medium', text: 'medium', image: 'medium', heatmap: 'large', profile: 'large', timeline: 'large' };

function buildVisualCard(spec) {
  const size = spec.size || DEFAULT_SIZE[spec.type];
  const c = card((spec.title || '').toUpperCase(), SIZE_CLASS[size] || '');
  c.dataset.type = spec.type;

  if (spec.type === 'stat') {
    const big = el('div', 'bf-big');
    big.append(el('span', '', spec.value));
    if (typeof spec.change === 'number') big.append(chip(spec.change));
    c.append(big);
    if (spec.caption) c.append(el('div', 'bf-sub', spec.caption));
  }

  if (spec.type === 'chart') {
    const host = el('div', 'viz-host');
    c.append(host);
    // Alternar gráfico ↔ tabela (os mesmos valores, acessíveis sem depender de cor)
    const toggle = el('button', 'viz-toggle', 'tabela');
    c.querySelector('.bf-label').append(toggle);
    let asTable = false;
    const render = () => {
      if (asTable) {
        host.innerHTML = '';
        host.append(dataTable(['', ...spec.series.map((s) => s.name || 'valor')],
          spec.labels.map((l, i) => [l, ...spec.series.map((s) => fmtNum(s.values[i], spec.unit))])));
      } else drawChart(host, { ...spec, size });
    };
    toggle.onclick = () => { asTable = !asTable; toggle.textContent = asTable ? 'gráfico' : 'tabela'; render(); };
    c.onMount = () => {
      render();
      new ResizeObserver(() => { if (!asTable) render(); }).observe(host);
    };
  }

  if (spec.type === 'table') c.append(dataTable(spec.columns, spec.rows));

  if (spec.type === 'list') {
    const ul = el('ul', 'bf-news');
    spec.items.forEach((it) => {
      const li = el('li');
      li.append(el('span', '', it.title));
      if (it.subtitle) li.append(el('small', '', it.subtitle));
      if (it.link) { li.onclick = () => J.openExternal(it.link); li.title = 'Abrir'; } else li.style.cursor = 'default';
      ul.append(li);
    });
    c.append(ul);
  }

  if (spec.type === 'text') c.append(el('p', 'bf-curio viz-text', spec.text));

  if (spec.type === 'image') {
    const fig = el('figure', 'bf-meme');
    const img = el('img');
    img.src = spec.url;
    img.alt = spec.caption || spec.title || '';
    img.onerror = () => c.remove();
    fig.append(img);
    if (spec.caption) fig.append(el('figcaption', '', spec.caption));
    c.append(fig);
  }

  // Card de conhecimento (estilo painel lateral do Google): foto + descrição + resumo + link
  if (spec.type === 'profile') {
    const wrap = el('div', 'kb');
    if (spec.image) {
      const img = el('img', 'kb-img');
      img.src = spec.image;
      img.alt = spec.title;
      img.onerror = () => img.remove();
      wrap.append(img);
    }
    const body = el('div', 'kb-body');
    body.append(el('h2', 'kb-title', spec.title));
    if (spec.description) body.append(el('div', 'kb-desc', spec.description));
    body.append(el('p', 'kb-text', spec.text));
    if (spec.url) {
      const a = el('button', 'btn kb-link', 'Ler na Wikipédia ↗');
      a.onclick = () => J.openExternal(spec.url);
      body.append(a);
    }
    wrap.append(body);
    c.append(wrap);
  }

  // Linha do tempo: história, etapas, passo a passo
  if (spec.type === 'timeline') {
    const ol = el('ol', 'tl');
    spec.items.forEach((it, i) => {
      const li = el('li', 'tl-item');
      li.style.animationDelay = `${300 + i * 120}ms`;
      li.append(el('span', 'tl-date', it.date || String(i + 1)));
      const box = el('div', 'tl-box');
      box.append(el('b', '', it.title));
      if (it.text) box.append(el('p', '', it.text));
      li.append(box);
      ol.append(li);
    });
    c.append(ol);
  }

  if (spec.type === 'heatmap') {
    const host = el('div', 'viz-host');
    c.append(host);
    c.onMount = () => {
      heatmap(host, spec.days);
      new ResizeObserver(() => heatmap(host, spec.days)).observe(host);
    };
  }
  return c;
}

// ------------------------------------------------------------ câmera do celular

J.onCameraPair(({ qr, url }) => {
  $('camQr').src = qr;
  $('camUrl').textContent = url;
  $('camPair').hidden = false;
});
$('camPairClose').addEventListener('click', () => { $('camPair').hidden = true; });

// A miniatura só aparece enquanto chegam imagens (o celular pode estar conectado com a câmera desligada)
let lastCamFrame = 0;
J.onCameraState(({ connected }) => {
  if (connected) $('camPair').hidden = true;
  else { $('cam').hidden = true; $('camImg').removeAttribute('src'); }
});
setInterval(() => { if (Date.now() - lastCamFrame > 3000 && !$('cam').hidden) $('cam').hidden = true; }, 1000);
J.onCameraFrame((b64) => {
  lastCamFrame = Date.now();
  $('cam').hidden = false;
  $('camImg').src = `data:image/jpeg;base64,${b64}`;
});
// "Flash" quando o JARVIS tira uma foto para analisar
J.onCameraSnap(() => {
  const cam = $('cam');
  cam.classList.remove('snap');
  void cam.offsetWidth;
  cam.classList.add('snap');
});
$('cam').addEventListener('click', () => $('cam').classList.toggle('big'));

// Indicador do modo sentinela na barra de título
J.onSentinel((s) => {
  const badge = $('sentinelBadge');
  badge.hidden = !s.active;
  if (!s.active) return;
  badge.textContent = s.armed ? `● SENTINELA${s.events ? ` · ${s.events} ALERTA${s.events > 1 ? 'S' : ''}` : ''}` : '◌ SENTINELA ARMANDO...';
  badge.classList.toggle('armed', !!s.armed);
});

J.onVisual((v) => {
  // Na tela de Chat o visual entra na conversa (chat.js); no resto, no painel holográfico
  if (typeof chatVisual === 'function' && currentScreen === 'chat') { chatVisual(v); return; }
  showPanel({ kicker: v.kicker || 'J.A.R.V.I.S.', title: v.title, subtitle: v.subtitle }, () => v.cards.map(buildVisualCard));
});

function closeBriefing() {
  const box = $('briefing');
  if (box.hidden) return;
  bf.timers.forEach(clearTimeout);
  hideTip();
  box.classList.add('closing');
  setTimeout(() => { box.hidden = true; box.classList.remove('closing'); }, 300);
}

J.onBriefing(openBriefing);
J.onBriefingClose(closeBriefing);
$('bfClose').addEventListener('click', closeBriefing);
$('btnBriefing').addEventListener('click', () => { audioCtx.resume(); J.requestBriefing(); });

J.onAction(({ name, arg }) => {
  const li = document.createElement('li');
  const b = document.createElement('b');
  b.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + ' ';
  li.append(b, arg ? `${name} ${arg}` : name);
  $('actionLog').prepend(li);
  while ($('actionLog').children.length > 30) $('actionLog').lastChild.remove();
});

J.onNowPlaying((s) => {
  $('npTitle').textContent = s ? s.title : 'Nada tocando';
  $('npArtist').textContent = s ? s.artist : 'Diga "toca alguma coisa"';
  if (s && s.cover) { if ($('npCover').src !== s.cover) $('npCover').src = s.cover; } else $('npCover').removeAttribute('src');
  $('npToggle').textContent = s && !s.paused ? '⏸' : '▶';
  $('npProgress').style.width = s && s.duration ? Math.min(100, (s.elapsed / s.duration) * 100) + '%' : '0';
});
document.querySelectorAll('[data-music]').forEach((b) => b.addEventListener('click', () => J.musicControl(b.dataset.music)));

function toast(text, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}
J.onToast(({ text, type }) => toast(text, type));

setInterval(() => {
  $('clock').textContent = new Date().toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).toUpperCase();
}, 1000);

document.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => J.win(b.dataset.win)));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('camPair').hidden = true; closeBriefing(); }
  if (e.ctrlKey && e.code === 'Space') { audioCtx.resume(); J.startListening(); }
});

// Configurações e demais telas: screens.js
