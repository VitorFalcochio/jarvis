// Tela de Chat (estilo ChatGPT) + barras laterais recolhíveis.
// A conversa é a MESMA do diálogo do HUD: o elemento #chat muda de lugar ao entrar/sair desta tela,
// então tudo que o renderer.js já desenha (passos, botões, notas) continua funcionando aqui.
// Usa os globais do renderer.js/screens.js ($, el, J, chat, toast, hooks, go, currentScreen...).

const store = {
  get(k, d) { try { const v = localStorage.getItem(`jarvis.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`jarvis.${k}`, JSON.stringify(v)); } catch {} },
};

// ------------------------------------------------------------ barras recolhíveis

function setRail(hidden) {
  document.body.classList.toggle('rail-hidden', hidden);
  store.set('railHidden', hidden);
}
function setDialog(hidden) {
  document.body.classList.toggle('dialog-hidden', hidden);
  $('btnDialog').classList.toggle('off', hidden);
  store.set('dialogHidden', hidden);
}
setRail(store.get('railHidden', false));
setDialog(store.get('dialogHidden', false));
$('btnRail').addEventListener('click', () => setRail(!document.body.classList.contains('rail-hidden')));
$('btnDialog').addEventListener('click', () => setDialog(!document.body.classList.contains('dialog-hidden')));
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey || e.code !== 'KeyB') return;
  e.preventDefault();
  if (e.shiftKey) setDialog(!document.body.classList.contains('dialog-hidden'));
  else setRail(!document.body.classList.contains('rail-hidden'));
});

// ------------------------------------------------------------ envio

let chatVoice = store.get('chatVoice', false);

// Tudo que sai da interface (texto, botões, formulários) passa por aqui:
// na tela de Chat a resposta vem escrita, com voz só se o usuário ligar
// opts.effort força um nível; opts.button = clique num botão/formulário (não refaz o conselho inteiro,
// a não ser que o botão peça mais ideias)
function uiSend(text, attachments, opts = {}) {
  audioCtx.resume();
  if (currentScreen !== 'chat') { J.sendText(text, attachments ? { attachments } : undefined); return; }
  let effort = opts.effort || chatEffort;
  if (opts.button && effort === 'max' && !/ousad|mais ideias|outras (op|ideias)|de novo/i.test(text)) effort = 'mid';
  lastAsk = { text, effort };
  J.sendText(text, { chat: true, speak: chatVoice, attachments, effort });
}

// ------------------------------------------------------------ esforço

let chatEffort = 'mid'; // ao abrir o JARVIS o chat começa no Médio
let lastAsk = null;
function renderEffort() {
  $('csEffort').querySelectorAll('button').forEach((b) => {
    const on = b.dataset.effort === chatEffort;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });
  $('csText').placeholder = chatEffort === 'max'
    ? 'Descreva o que quer criar ou resolver: o conselho vai explorar várias abordagens'
    : 'Pergunte qualquer coisa ao JARVIS';
}
$('csEffort').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-effort]');
  if (!b) return;
  chatEffort = b.dataset.effort;
  renderEffort();
  $('csText').focus();
});
renderEffort();

function renderVoiceBtn() {
  $('csVoice').textContent = chatVoice ? '🔊 Voz ligada' : '🔇 Voz desligada';
  $('csVoice').classList.toggle('on', chatVoice);
}
renderVoiceBtn();
$('csVoice').addEventListener('click', () => {
  chatVoice = !chatVoice;
  store.set('chatVoice', chatVoice);
  renderVoiceBtn();
  if (!chatVoice) stopSpeaking();
});

const csText = $('csText');
const autosize = () => { csText.style.height = 'auto'; csText.style.height = `${Math.min(csText.scrollHeight, 220)}px`; };
csText.addEventListener('input', autosize);
csText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('csForm').requestSubmit(); }
});

let csBusy = false;
$('csForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (csBusy) { J.stop(); stopSpeaking(); sealAiBubble(); return; } // o botão vira "parar" enquanto ele pensa
  const text = csText.value.trim();
  if (attachQueue.some((a) => a.state === 'loading')) { toast('Espera os anexos terminarem de carregar.', 'error'); return; }
  const ready = attachQueue.filter((a) => a.state === 'ok');
  if (!text && !ready.length) return;
  csText.value = '';
  autosize();
  sentThumbs = ready.filter((a) => a.kind === 'image').map((a) => a.preview);
  uiSend(text, ready.length ? ready.map((a) => (a.kind === 'image' ? { name: a.name, kind: 'image', jpeg: a.jpeg } : { name: a.name, kind: a.kind, text: a.text, meta: a.meta })) : undefined);
  attachQueue = [];
  renderTray();
});

// ------------------------------------------------------------ anexos

let attachQueue = []; // { id, name, kind, state: loading|ok|err, meta, text?, jpeg?, preview?, error? }
let sentThumbs = [];
const KIND_ICON = { image: '🖼', pdf: '📕', sheet: '📊', docx: '📘', text: '📄' };

// Imagem → JPEG em base64 (no máx. 1600 px), que é o que o modelo de visão recebe
async function toJpeg(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * scale);
  cv.height = Math.round(bmp.height * scale);
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; // PNG transparente não vira fundo preto
  g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(bmp, 0, 0, cv.width, cv.height);
  const url = cv.toDataURL('image/jpeg', 0.86);
  return { jpeg: url.split(',')[1], preview: url, meta: `${bmp.width}×${bmp.height}` };
}

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
async function addAttachments(files) {
  for (const file of files) {
    if (attachQueue.length >= 8) { toast('No máximo 8 anexos por mensagem.', 'error'); break; }
    const name = file.name || `print-${new Date().toLocaleTimeString('pt-BR').replace(/:/g, '')}.png`;
    const a = { id: Math.random().toString(36).slice(2), name, kind: 'text', state: 'loading' };
    attachQueue.push(a);
    renderTray();
    try {
      if (file.type.startsWith('image/') || IMAGE_RE.test(name)) {
        Object.assign(a, { kind: 'image' }, await toJpeg(file));
      } else {
        const r = await J.fileExtract(name, new Uint8Array(await file.arrayBuffer()));
        if (!r.ok) throw new Error(r.error);
        Object.assign(a, { kind: r.kind, text: r.text, meta: r.meta });
      }
      a.state = 'ok';
    } catch (e) {
      a.state = 'err';
      a.error = e.message;
      toast(`${name}: ${e.message}`, 'error');
    }
    renderTray();
  }
}

function renderTray() {
  const tray = $('csTray');
  tray.innerHTML = '';
  tray.hidden = !attachQueue.length;
  attachQueue.forEach((a) => {
    const chip = el('div', `cs-att is-${a.state}`);
    chip.title = a.error || a.name;
    if (a.preview) { const img = el('img'); img.src = a.preview; chip.append(img); } else chip.append(el('span', 'cs-att-ic', a.state === 'loading' ? '' : KIND_ICON[a.kind] || '📄'));
    const info = el('div', 'cs-att-info');
    info.append(el('b', '', a.name), el('small', '', a.state === 'loading' ? 'lendo…' : a.state === 'err' ? 'não consegui ler' : a.meta || ''));
    chip.append(info, button('×', 'cs-att-x', () => { attachQueue = attachQueue.filter((x) => x !== a); renderTray(); }, 'Remover'));
    tray.append(chip);
  });
}

$('csClip').addEventListener('click', () => $('csFile').click());
$('csFile').addEventListener('change', (e) => { addAttachments([...e.target.files]); e.target.value = ''; });

// Colar print (Ctrl+V) direto no campo
csText.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addAttachments(files);
});

// Arrastar e soltar em qualquer lugar da tela de Chat
let dragDepth = 0;
const chatScreen = $('scr-chat');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
chatScreen.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('csDrop').hidden = false; });
chatScreen.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
chatScreen.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('csDrop').hidden = true; } });
chatScreen.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('csDrop').hidden = true;
  addAttachments([...e.dataTransfer.files]);
  csText.focus();
});

// As miniaturas das imagens enviadas aparecem no balão do usuário
J.onUserMessage(() => {
  if (!sentThumbs.length) return;
  const bubble = [...chat.querySelectorAll('.msg.user')].pop();
  if (bubble) {
    const row = el('div', 'msg-thumbs');
    sentThumbs.forEach((src) => { const img = el('img'); img.src = src; img.onclick = () => openLightbox([{ thumb: src, title: 'Anexo' }], 0); row.append(img); });
    bubble.append(row);
  }
  sentThumbs = [];
});

$('csMic').addEventListener('click', () => { audioCtx.resume(); J.startListening(); });

$('csNew').addEventListener('click', async () => {
  await J.clearHistory();
  chat.innerHTML = '';
  toast('Conversa nova. O contexto anterior foi esquecido.');
  csText.focus();
});

// Estado do JARVIS (o mesmo do orbe): lido do #status, que o renderer já atualiza
const STATE_LABEL = { idle: 'pronto', listening: 'ouvindo…', thinking: 'pensando…', searching: 'trabalhando…', speaking: 'falando…', loading: 'iniciando…', offline: 'sem voz' };
new MutationObserver(() => {
  const st = $('status').className.replace('status', '').trim() || 'idle';
  $('csDot').className = `cs-dot ${st}`;
  $('csState').textContent = STATE_LABEL[st] || st;
  $('csMic').classList.toggle('listening', st === 'listening');
  csBusy = st === 'thinking' || st === 'searching';
  $('csSend').classList.toggle('stop', csBusy);
  $('csSend').textContent = csBusy ? '■' : '➤';
  $('csSend').title = csBusy ? 'Parar' : 'Enviar';
}).observe($('status'), { attributes: true, attributeFilter: ['class'] });

// ------------------------------------------------------------ a tela

const chatHome = chat.parentElement;
const emptyState = () => { $('csEmpty').hidden = chat.children.length > 0; };
new MutationObserver(emptyState).observe(chat, { childList: true });

const SUGGESTIONS = [
  'Onde eu parei no projeto?',
  'Compara React e Vue numa tabela',
  'Me mostra fotos da Islândia',
  'Gráfico do dólar nos últimos 30 dias',
  'Me ajuda a planejar um app novo',
  'Quanto gastei esse mês?',
];

function greet() {
  const h = new Date().getHours();
  const part = h < 5 ? 'Boa madrugada' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  J.getConfig().then((c) => { $('csHello').textContent = `${part}, ${c.userName || 'senhor'}. Como posso ajudar?`; }).catch(() => {});
  const box = $('csSuggest');
  if (box.children.length) return;
  SUGGESTIONS.forEach((s) => box.append(button(s, 'cs-chip', () => uiSend(s))));
}

hooks.chat = {
  enter() {
    $('csBody').append(chat);
    emptyState();
    greet();
    chat.scrollTop = chat.scrollHeight;
    setTimeout(() => csText.focus(), 50);
  },
  leave() {
    chatHome.insertBefore(chat, $('form'));
    chat.scrollTop = chat.scrollHeight;
  },
};

// ------------------------------------------------------------ conteúdo rico na conversa

const scrollChat = () => { if (choicesBox) chat.append(choicesBox); chat.scrollTop = chat.scrollHeight; };

// Cards do show_visual (gráficos, tabelas, números...) dentro da conversa
function chatVisual(v) {
  sealAiBubble();
  aiBubble = null;
  const box = addBubble('rich visual');
  const head = el('div', 'rich-head');
  head.append(el('span', 'rich-kicker', v.kicker || 'J.A.R.V.I.S.'));
  if (v.title) head.append(el('b', '', v.title));
  if (v.subtitle) head.append(el('small', 'muted', v.subtitle));
  const grid = el('div', 'bf-grid rich-grid');
  const cards = v.cards.map(buildVisualCard);
  cards.forEach((c) => grid.append(c));
  box.append(head, grid);
  cards.forEach((c) => c.onMount && c.onMount());
  cards.forEach((c, i) => setTimeout(() => { c.classList.add('in'); c.onAppear && c.onAppear(); }, 120 + i * 180));
  scrollChat();
}

// Formulário de perguntas / enquete (skills/chat.js → chat_ask)
J.onAiForm(({ title, questions }) => {
  sealAiBubble();
  aiBubble = null;
  const box = addBubble('rich form');
  if (title) box.append(el('div', 'rich-kicker', title));
  const answers = {};
  const submit = button('Enviar respostas', 'primary', () => {});

  const refresh = () => {
    const done = questions.filter((q) => {
      const a = answers[q.id];
      return Array.isArray(a) ? a.length : a !== undefined && String(a).trim() !== '';
    }).length;
    submit.disabled = done === 0;
    submit.textContent = done === questions.length ? 'Enviar respostas' : `Enviar (${done}/${questions.length})`;
  };

  questions.forEach((q, qi) => {
    const block = el('fieldset', `fq fq-${q.kind}`);
    block.append(el('legend', '', `${questions.length > 1 ? `${qi + 1}. ` : ''}${q.text}`));

    if (q.kind === 'single' || q.kind === 'poll' || q.kind === 'multi') {
      const opts = el('div', 'fq-opts');
      q.options.forEach((o, i) => {
        const b = el('button', 'fq-opt');
        b.type = 'button';
        if (q.kind === 'poll') b.append(el('span', 'fq-letter', String.fromCharCode(65 + i)));
        b.append(el('span', '', o));
        b.onclick = () => {
          if (q.kind === 'multi') {
            const set = new Set(answers[q.id] || []);
            set.has(o) ? set.delete(o) : set.add(o);
            answers[q.id] = q.options.filter((x) => set.has(x));
            b.classList.toggle('on', set.has(o));
          } else {
            answers[q.id] = o;
            opts.querySelectorAll('.fq-opt').forEach((x) => x.classList.toggle('on', x === b));
          }
          refresh();
        };
        opts.append(b);
      });
      block.append(opts);
    }

    if (q.kind === 'scale') {
      const opts = el('div', 'fq-scale');
      for (let n = 1; n <= 5; n++) {
        const b = el('button', 'fq-star', '★');
        b.type = 'button';
        b.title = `${n} de 5`;
        b.onclick = () => {
          answers[q.id] = n;
          opts.querySelectorAll('.fq-star').forEach((x, i) => x.classList.toggle('on', i < n));
          refresh();
        };
        opts.append(b);
      }
      block.append(opts);
    }

    if (q.kind === 'text') {
      const input = el('textarea', 'fq-input');
      input.rows = 2;
      input.placeholder = 'Sua resposta…';
      input.oninput = () => { answers[q.id] = input.value; refresh(); };
      block.append(input);
    }
    box.append(block);
  });

  submit.onclick = () => {
    const lines = questions
      .filter((q) => answers[q.id] !== undefined && String(answers[q.id]).trim() !== '' && !(Array.isArray(answers[q.id]) && !answers[q.id].length))
      .map((q) => {
        const a = answers[q.id];
        return `- ${q.text} → ${Array.isArray(a) ? a.join(', ') : q.kind === 'scale' ? `${a}/5` : String(a).trim()}`;
      });
    if (!lines.length) return;
    box.classList.add('used');
    box.querySelectorAll('button, textarea').forEach((x) => { x.disabled = true; });
    uiSend(`${title ? `Respostas (${title}):` : 'Minhas respostas:'}\n${lines.join('\n')}`, undefined, { button: true });
  };
  const foot = el('div', 'fq-foot');
  foot.append(submit);
  box.append(foot);
  refresh();
  scrollChat();
});

// Galeria de fotos (skills/chat.js → show_images)
J.onAiImages(({ query, images }) => {
  sealAiBubble();
  aiBubble = null;
  const box = addBubble('rich gallery');
  box.append(el('div', 'rich-kicker', `FOTOS · ${query.toUpperCase()}`));
  const grid = el('div', 'gal-grid');
  images.forEach((im, i) => {
    const fig = el('figure', 'gal-item');
    fig.style.animationDelay = `${i * 70}ms`;
    const img = el('img');
    img.src = im.thumb;
    img.alt = im.title;
    img.onerror = () => fig.remove();
    fig.append(img, el('figcaption', '', im.title));
    fig.onclick = () => openLightbox(images, i);
    grid.append(fig);
  });
  box.append(grid, el('small', 'muted gal-credit', 'Imagens: Wikimedia Commons'));
  scrollChat();
});

function openLightbox(images, start) {
  let i = start;
  const lb = el('div', 'lightbox');
  const img = el('img');
  const cap = el('div', 'lb-cap');
  const show = () => {
    img.src = images[i].thumb;
    cap.textContent = '';
    cap.append(el('span', '', `${i + 1}/${images.length} · ${images[i].title}`));
    const link = images[i].page || images[i].url;
    if (/^https:\/\//.test(link || '')) cap.append(button('Abrir original ↗', 'mini', (e) => { e.stopPropagation(); J.openExternal(link); }));
  };
  const step = (d) => { i = (i + d + images.length) % images.length; show(); };
  const prev = button('‹', 'lb-nav prev', (e) => { e.stopPropagation(); step(-1); });
  const next = button('›', 'lb-nav next', (e) => { e.stopPropagation(); step(1); });
  const close = () => { lb.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  };
  img.onclick = (e) => e.stopPropagation();
  lb.onclick = close;
  lb.append(img, cap, prev, next);
  document.body.append(lb);
  document.addEventListener('keydown', onKey, true);
  show();
}

// Arquivo solto fora das áreas de anexo: o Electron abriria o arquivo no lugar do JARVIS
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
