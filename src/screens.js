// Telas do JARVIS: navegação, Música, Projetos, Agenda, Memória e Configurações.
// Usa os utilitários globais do renderer.js ($, el, J, toast, drawChart, closeBriefing, audioCtx).

const SCREENS = ['hud', 'music', 'projects', 'agenda', 'memory', 'settings', 'research', 'oficina', 'chat'];
const hooks = {}; // por tela: { enter(), leave() }
let currentScreen = 'hud';

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const normalize = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function button(label, cls, onClick, title) {
  const b = el('button', `btn ${cls || ''}`.trim(), label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

// ------------------------------------------------------------ navegação

function go(name) {
  if (!SCREENS.includes(name)) return;
  if (name === currentScreen) { closeBriefing(); hooks[name]?.enter?.(); return; }
  hooks[currentScreen]?.leave?.();
  currentScreen = name;
  document.querySelector('.hud').dataset.screen = name;
  document.querySelectorAll('#rail button').forEach((b) => b.classList.toggle('active', b.dataset.screen === name));
  document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== `scr-${name}`; });
  closeBriefing();
  const scr = $(`scr-${name}`);
  if (scr) { scr.classList.remove('enter'); void scr.offsetWidth; scr.classList.add('enter'); }
  hooks[name]?.enter?.();
  J.setScreen(name);
}

document.querySelectorAll('#rail button').forEach((b) => b.addEventListener('click', () => go(b.dataset.screen)));
$('btnSettings')?.addEventListener('click', () => go('settings'));
J.onNavigate(go);
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) { e.preventDefault(); go(SCREENS[Number(e.code.slice(5)) - 1]); }
});

// ------------------------------------------------------------ MÚSICA

const mu = { song: null, base: null, key: '', lyrics: null, lineEls: [], activeLine: -1, raf: 0, viz: null, seeking: false };

function songElapsed() {
  if (!mu.base) return 0;
  const extra = mu.base.paused ? 0 : (performance.now() - mu.base.at) / 1000;
  return Math.min(mu.base.duration || Infinity, mu.base.elapsed + extra);
}

J.onNowPlaying((s) => {
  mu.song = s;
  if (!s) {
    mu.base = null;
    if (currentScreen === 'music') renderSong();
    return;
  }
  mu.base = { elapsed: s.elapsed || 0, duration: s.duration || 0, paused: s.paused, at: performance.now() };
  const key = `${s.title}|${s.artist}`;
  if (key !== mu.key) {
    mu.key = key;
    mu.lyrics = null;
    if (currentScreen === 'music') { loadLyrics(); loadQueue(); }
  }
  if (currentScreen === 'music') renderSong();
});

function renderSong() {
  const s = mu.song;
  $('muTitle').textContent = s ? s.title : 'Nada tocando';
  $('muArtist').textContent = s ? [s.artist, s.album].filter(Boolean).join(' · ') : 'Diga "toca alguma coisa" ou escolha uma playlist';
  if (s?.cover) { if ($('muCover').src !== s.cover) $('muCover').src = s.cover; } else $('muCover').removeAttribute('src');
  $('muToggle').textContent = s && !s.paused ? '⏸' : '▶';
  $('muCover').classList.toggle('paused', !s || s.paused);
  $('muDuration').textContent = fmtTime(s?.duration);
  $('muSeek').max = Math.max(1, Math.round(s?.duration || 1));
}

async function loadLyrics() {
  const s = mu.song;
  const box = $('muLyrics');
  mu.lineEls = [];
  mu.activeLine = -1;
  if (!s) { box.innerHTML = '<p class="muted">A letra aparece aqui quando uma música estiver tocando.</p>'; $('muLyricsInfo').textContent = ''; return; }
  box.innerHTML = '<p class="muted">Procurando a letra...</p>';
  const key = mu.key;
  const lyr = await J.musicLyrics({ title: s.title, artist: s.artist, album: s.album, duration: s.duration });
  if (key !== mu.key) return; // a música mudou enquanto buscava
  mu.lyrics = lyr;
  box.innerHTML = '';
  if (!lyr || !lyr.lines.length) {
    box.innerHTML = `<p class="muted">${lyr?.instrumental ? 'Música instrumental.' : 'Não encontrei a letra desta música.'}</p>`;
    $('muLyricsInfo').textContent = '';
    return;
  }
  $('muLyricsInfo').textContent = lyr.synced ? '· sincronizada · clique numa linha para pular' : '· sem sincronia';
  box.classList.toggle('plain', !lyr.synced);
  box.append(el('div', 'mu-pad'));
  lyr.lines.forEach((line) => {
    const p = el('p', 'mu-line', line.text || '♪');
    if (line.time !== null) {
      p.addEventListener('click', () => { J.musicOp('seek', line.time); if (mu.base) { mu.base.elapsed = line.time; mu.base.at = performance.now(); } });
    }
    box.append(p);
    mu.lineEls.push(p);
  });
  box.append(el('div', 'mu-pad'));
}

// Atualiza progresso e linha atual da letra a cada quadro
function musicTick() {
  const t = songElapsed();
  if (!mu.seeking) $('muSeek').value = Math.round(t);
  $('muElapsed').textContent = fmtTime(mu.seeking ? $('muSeek').value : t);
  if (mu.lyrics?.synced && mu.lineEls.length) {
    let idx = -1;
    for (let i = 0; i < mu.lyrics.lines.length; i++) if (mu.lyrics.lines[i].time <= t + 0.25) idx = i;
    if (idx !== mu.activeLine) {
      mu.lineEls[mu.activeLine]?.classList.remove('active');
      mu.activeLine = idx;
      const line = mu.lineEls[idx];
      if (line) {
        line.classList.add('active');
        const box = $('muLyrics');
        box.scrollTo({ top: line.offsetTop - box.clientHeight / 2 + line.clientHeight / 2, behavior: 'smooth' });
      }
    }
  }
  drawViz();
  mu.raf = requestAnimationFrame(musicTick);
}

async function loadQueue() {
  const items = await J.musicQueue();
  const ul = $('muQueue');
  ul.innerHTML = '';
  const cur = items.findIndex((i) => i.selected);
  const next = items.slice(cur + 1, cur + 21);
  if (!next.length) { ul.append(el('li', 'muted', 'A fila está vazia.')); return; }
  next.forEach((it) => {
    const li = el('li');
    const img = el('img');
    if (it.thumb) img.src = it.thumb;
    img.alt = '';
    const txt = el('div');
    txt.append(el('b', '', it.title), el('span', 'muted', it.artist));
    li.append(img, txt, el('small', 'muted', it.length));
    li.title = 'Tocar agora';
    li.addEventListener('click', () => J.musicOp('queue-index', it.index).then(() => setTimeout(loadQueue, 900)));
    ul.append(li);
  });
}

async function loadPlaylists() {
  const box = $('muPlaylists');
  if (box.childElementCount > 1) return; // só carrega uma vez
  box.innerHTML = '<span class="muted">Carregando...</span>';
  const lists = await J.musicPlaylists();
  box.innerHTML = '';
  if (!lists.length) { box.append(el('span', 'muted', 'Abra o YouTube Music pelo JARVIS para ver suas playlists.')); return; }
  lists.forEach((p) => box.append(button(p.title, 'mu-pl', () => { J.musicOp('playlist', p.id); toast(`Tocando ${p.title}`); }, 'Tocar playlist')));
}

// Visualizador: barras circulares ao redor da capa, com o áudio do sistema
async function startViz() {
  if (mu.viz) return;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) throw new Error('sem áudio');
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 256;
    an.smoothingTimeConstant = 0.75;
    src.connect(an); // não conecta na saída: só analisa
    mu.viz = { stream, an, data: new Uint8Array(an.frequencyBinCount) };
  } catch (e) {
    console.warn('visualizador indisponível:', e.message);
  }
}
function stopViz() {
  if (!mu.viz) return;
  mu.viz.stream.getTracks().forEach((t) => t.stop());
  mu.viz = null;
}
function drawViz() {
  const c = $('muViz');
  const size = c.clientWidth * devicePixelRatio;
  if (c.width !== size) { c.width = size; c.height = size; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  if (!mu.viz) return;
  mu.viz.an.getByteFrequencyData(mu.viz.data);
  const bars = 72, cx = size / 2, inner = size * 0.36, maxLen = size * 0.13;
  g.lineWidth = Math.max(2, size / 180);
  g.lineCap = 'round';
  for (let i = 0; i < bars; i++) {
    // espelha as frequências graves dos dois lados para ficar simétrico
    const bin = Math.floor((i < bars / 2 ? i : bars - i) * 0.9) + 1;
    const v = mu.viz.data[bin] / 255;
    const a = (i / bars) * Math.PI * 2 - Math.PI / 2;
    const len = 2 + v * v * maxLen;
    g.strokeStyle = `rgba(${getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb')}, ${0.25 + v * 0.75})`;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * inner, cx + Math.sin(a) * inner);
    g.lineTo(cx + Math.cos(a) * (inner + len), cx + Math.sin(a) * (inner + len));
    g.stroke();
  }
}

document.querySelectorAll('[data-mu]').forEach((b) => b.addEventListener('click', () => J.musicControl(b.dataset.mu)));
$('muSeek').addEventListener('input', () => { mu.seeking = true; });
$('muSeek').addEventListener('change', () => {
  const v = Number($('muSeek').value);
  mu.seeking = false;
  J.musicOp('seek', v);
  if (mu.base) { mu.base.elapsed = v; mu.base.at = performance.now(); }
});
$('muVolume').addEventListener('input', debounce(() => J.musicOp('volume', Number($('muVolume').value)), 150));

hooks.music = {
  enter() {
    renderSong();
    if (!mu.lyrics) loadLyrics();
    loadQueue();
    loadPlaylists();
    J.musicVolume().then((v) => { if (v !== null) $('muVolume').value = v; });
    startViz();
    cancelAnimationFrame(mu.raf);
    mu.raf = requestAnimationFrame(musicTick);
    mu.queueTimer = setInterval(loadQueue, 15000);
  },
  leave() {
    cancelAnimationFrame(mu.raf);
    clearInterval(mu.queueTimer);
    stopViz();
  },
};

// ------------------------------------------------------------ PROJETOS

const JARVIS_PORTS = new Set([8765, 8443, 9229, 26538]);
// Processos do Windows que nunca devem ser encerrados por um clique
const SYSTEM_PROCESSES = /^(svchost|system|lsass|services|wininit|csrss|smss|winlogon|spoolsv|dwm|explorer|memcompression|registry|fontdrvhost|dashost|searchhost|searchindexer|msmpeng|nissrv|audiodg|conhost)\.exe$|^system$|^desconhecido$/i;

async function loadProjects() {
  const grid = $('prGrid');
  grid.innerHTML = '<p class="muted">Lendo os projetos...</p>';
  const cfg = await J.getConfig();
  $('prRoot').textContent = cfg.projectsDir;
  const projects = await J.projectsOverview().catch(() => []);
  const mems = await J.projmemData(projects.map((p) => p.name)).catch(() => ({}));
  grid.innerHTML = '';
  if (!projects.length) { grid.append(el('p', 'muted', `Nenhum projeto encontrado em ${cfg.projectsDir}.`)); return; }
  projects.forEach((p, i) => {
    const c = el('article', `pr-card${p.current ? ' current' : ''}`);
    c.style.animationDelay = `${i * 80}ms`;
    const head = el('div', 'pr-head');
    head.append(el('h3', '', p.name));
    const chips = el('div', 'pr-chips');
    p.kinds.forEach((k) => chips.append(el('span', 'pr-chip', k)));
    if (p.current) chips.append(el('span', 'pr-chip on', 'atual'));
    head.append(chips);
    c.append(head, el('small', 'pr-path muted', p.path));

    if (p.branch) {
      const st = el('div', 'pr-status');
      st.append(el('span', '', `⎇ ${p.branch}`));
      if (p.changed) st.append(el('span', 'warn', `${p.changed} alterado${p.changed > 1 ? 's' : ''}`));
      else st.append(el('span', 'ok', 'tudo commitado'));
      if (p.ahead) st.append(el('span', '', `↑ ${p.ahead} para enviar`));
      if (p.behind) st.append(el('span', 'warn', `↓ ${p.behind} para baixar`));
      st.append(el('span', 'muted', `${p.commits7d} commits em 7 dias`));
      c.append(st);
      if (p.lastCommit) {
        const lc = el('div', 'pr-last');
        lc.append(el('span', '', p.lastCommit.msg), el('small', 'muted', p.lastCommit.when));
        c.append(lc);
      }
    }
    if (p.error) c.append(el('small', 'warn', p.error));
    c.append(projectMemory(p, mems[p.name]));

    const actions = el('div', 'pr-actions');
    actions.append(button('Abrir no VS Code', 'primary', () => J.runTool('project_open', { project: p.name }).then(() => toast(`Abrindo ${p.name}...`))));
    if (p.scripts.length) {
      const sel = el('select', 'pr-select');
      sel.append(el('option', '', 'Rodar...'));
      p.scripts.forEach((s) => { const o = el('option', '', s); o.value = s; sel.append(o); });
      sel.addEventListener('change', () => {
        if (!sel.value || sel.selectedIndex === 0) return;
        J.runTool('project_run', { project: p.name, script: sel.value }).then((r) => toast(r.ok ? `Rodando ${r.running}` : r.error, r.ok ? 'ok' : 'error'));
        sel.selectedIndex = 0;
      });
      actions.append(sel);
    }
    actions.append(button('Onde parei?', '', () => { J.sendText(`Onde eu parei no ${p.name}?`); go('hud'); }, 'O JARVIS te situa no projeto'));
    actions.append(button('📘 Dossiê', '', () => openDossier({ project: p.name }), 'Ensinar o JARVIS sobre este projeto'));
    actions.append(button('Painel', '', () => J.runTool('project_dashboard', { project: p.name })));
    if (p.branch) actions.append(button('Pull', '', () => J.runTool('git_pull', { project: p.name }).then((r) => { toast(r.ok ? 'Projeto atualizado.' : r.error, r.ok ? 'ok' : 'error'); loadProjects(); }), 'git pull'));
    if (p.github) actions.append(button('GitHub ↗', '', () => J.openExternal(p.github)));
    c.append(actions);
    grid.append(c);
  });
}

const agoShort = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return m < 2 ? 'agora' : `${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
};

// Ficha de memória do projeto (skills/projmem.js): contexto, pendências, decisões e diário
function projectMemory(p, m) {
  m = m || { context: '', decisions: [], journal: [], tasks: [] };
  const box = el('details', 'pm');
  box.open = p.current;
  const counts = [m.decisions.length && `${m.decisions.length} decis${m.decisions.length > 1 ? 'ões' : 'ão'}`, m.tasks.length && `${m.tasks.length} pendente${m.tasks.length > 1 ? 's' : ''}`].filter(Boolean);
  const sum = el('summary', '', 'Memória');
  if (counts.length) sum.append(el('span', 'muted', ` · ${counts.join(' · ')}`));
  box.append(sum);
  const op = (o) => J.projmemOp({ project: p.name, ...o }).then(loadProjects);

  if (m.journal[0]) {
    const last = el('div', 'pm-last');
    last.append(el('span', 'pm-label', `Último · ${agoShort(m.journal[0].at)}`), el('span', '', m.journal[0].text));
    box.append(last);
  }

  // contexto: clique para editar
  const ctx = el('p', `pm-ctx${m.context ? '' : ' muted'}`, m.context || 'Sem contexto ainda. Clique para descrever o projeto.');
  ctx.title = 'Clique para editar';
  ctx.addEventListener('click', () => {
    const input = el('textarea', 'pm-edit');
    input.value = m.context;
    input.rows = 3;
    ctx.replaceWith(input);
    input.focus();
    const done = () => (input.value.trim() !== m.context ? op({ op: 'context', text: input.value.trim() }) : input.replaceWith(ctx));
    input.addEventListener('blur', done, { once: true });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = m.context; input.blur(); } });
  });
  box.append(ctx);

  if (m.tasks.length) {
    box.append(el('span', 'pm-label', 'Pendências'));
    const ul = el('ul', 'pm-list');
    m.tasks.forEach((t) => ul.append(el('li', 'pm-task', t.text)));
    box.append(ul);
  }

  box.append(el('span', 'pm-label', 'Decisões'));
  const ul = el('ul', 'pm-list');
  m.decisions.forEach((d) => {
    const li = el('li', '', d.text);
    li.append(button('×', 'mini', () => op({ op: 'remove', id: d.id }), 'Esquecer decisão'));
    ul.append(li);
  });
  const add = el('input', 'pm-add');
  add.placeholder = '+ nova decisão (Enter)';
  add.addEventListener('keydown', (e) => { if (e.key === 'Enter' && add.value.trim()) op({ op: 'decision', text: add.value.trim() }); });
  box.append(ul, add);

  if (m.journal.length > 1) {
    box.append(el('span', 'pm-label', 'Diário'));
    const log = el('ul', 'pm-list pm-log');
    m.journal.slice(1).forEach((j) => { const li = el('li', ''); li.append(el('small', 'muted', agoShort(j.at)), el('span', '', j.text)); log.append(li); });
    box.append(log);
  }
  return box;
}

J.onProjectMemory(debounce(() => { if (currentScreen === 'projects') loadProjects(); }, 800));

async function loadPorts() {
  const ul = $('prPorts');
  ul.innerHTML = '<li class="muted">Verificando...</li>';
  const ports = await J.projectsPorts().catch(() => []);
  ul.innerHTML = '';
  if (!ports.length) { ul.append(el('li', 'muted', 'Nenhuma porta de desenvolvimento em uso.')); return; }
  ports.sort((a, b) => a.port - b.port).forEach((p) => {
    const li = el('li');
    li.append(el('b', '', `:${p.port}`), el('span', '', p.process), el('small', 'muted', `PID ${p.pid}`));
    if (JARVIS_PORTS.has(p.port)) li.append(el('small', 'pr-chip', 'JARVIS'));
    else if (SYSTEM_PROCESSES.test(p.process)) li.append(el('small', 'pr-chip', 'WINDOWS'));
    else li.append(button('Encerrar', 'danger', async () => {
      if (!confirm(`Encerrar ${p.process} (PID ${p.pid}) na porta ${p.port}?`)) return;
      const r = await J.runTool('process_kill', { pid: p.pid });
      toast(r.ok ? `Processo ${p.pid} encerrado.` : r.error, r.ok ? 'ok' : 'error');
      loadPorts();
    }));
    ul.append(li);
  });
}

async function loadDocker() {
  const ul = $('prDocker');
  ul.innerHTML = '<li class="muted">Verificando...</li>';
  const d = await J.projectsContainers().catch(() => ({ running: false, error: 'erro' }));
  ul.innerHTML = '';
  if (!d.running) { ul.append(el('li', 'muted', d.error || 'Docker indisponível.')); return; }
  if (!d.list.length) { ul.append(el('li', 'muted', 'Nenhum container.')); return; }
  d.list.forEach((c) => {
    const up = /^Up/i.test(c.status);
    const li = el('li');
    li.append(el('i', `dot ${up ? 'on' : ''}`), el('b', '', c.name), el('small', 'muted', `${c.image} · ${c.status}`));
    li.append(button(up ? 'Parar' : 'Iniciar', up ? 'danger' : '', async () => {
      const r = await J.runTool('docker_container', { name: c.name, action: up ? 'stop' : 'start' });
      toast(r.ok ? 'Feito.' : r.error, r.ok ? 'ok' : 'error');
      loadDocker();
    }));
    ul.append(li);
  });
}

// Agentes de código: resumo da equipe (o acompanhamento completo, diff e aprovação ficam na Oficina)
const AGENT_STATUS = { running: ['TRABALHANDO', 'warn'], done: ['ESPERANDO APROVAÇÃO', 'ok'], failed: ['FALHOU', 'danger'], accepted: ['APLICADO', 'ok'], discarded: ['DESCARTADO', 'muted'] };
let agentTeam = { agents: [], jobs: [] };

function renderAgents() {
  const card = $('agentCard');
  const recent = agentTeam.jobs.filter((j) => !j.hidden && (['running', 'done', 'failed'].includes(j.status)));
  card.hidden = !recent.length;
  if (card.hidden) return;
  card.innerHTML = '';
  const h = el('h3', '', 'AGENTES DE CÓDIGO');
  h.append(button('Abrir a Oficina ▦', '', () => go('oficina')));
  card.append(h);
  recent.slice(-3).reverse().forEach((job) => {
    const a = agentTeam.agents.find((x) => x.id === job.agent) || {};
    const [label, cls] = AGENT_STATUS[job.status] || [job.status, ''];
    const row = el('div', 'ag-row');
    row.style.setProperty('--ag', a.color || 'var(--accent)');
    const head = el('div', 'ag-task-head');
    const name = el('b', '', `${a.short || 'AGENTE'} · ${job.project}`);
    head.append(name, el('span', `ag-chip ${cls}`, label));
    row.append(head, el('small', 'muted', job.task));
    const last = job.steps[job.steps.length - 1];
    if (job.status === 'running' && last) row.append(el('small', 'ag-last', `${last.icon} ${last.text}`));
    card.append(row);
  });
}

J.onAgent((job) => {
  if (!job) return;
  const i = agentTeam.jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) agentTeam.jobs[i] = job; else agentTeam.jobs.push(job);
  if (currentScreen === 'projects') renderAgents();
});

$('prRefresh').addEventListener('click', () => { loadProjects(); loadPorts(); loadDocker(); });
hooks.projects = { enter() { J.agentState().then((s) => { agentTeam = s; renderAgents(); }); loadProjects(); loadPorts(); loadDocker(); } };

// ------------------------------------------------------------ AGENDA

let agenda2 = { tasks: [], notes: [], reminders: [], focus: {} };

async function loadAgenda() {
  agenda2 = await J.agendaData();
  renderBoard();
  renderNotes();
  renderAgendaReminders();
  renderFocusChart();
}

function renderBoard() {
  const today = new Date().toISOString().slice(0, 10);
  document.querySelectorAll('.ag-col').forEach((col) => {
    const status = col.dataset.status;
    const list = col.querySelector('.ag-list');
    list.innerHTML = '';
    const tasks = agenda2.tasks.filter((t) => (t.status || (t.done ? 'done' : 'todo')) === status)
      .sort((a, b) => (status === 'done' ? (b.doneAt || 0) - (a.doneAt || 0) : (a.due || '9999').localeCompare(b.due || '9999')));
    col.querySelector('.ag-count').textContent = tasks.length || '';
    if (!tasks.length) list.append(el('li', 'ag-empty muted', status === 'todo' ? 'Nada aqui. Adicione acima ou diga "adiciona na lista..."' : status === 'doing' ? 'Arraste uma tarefa para cá' : 'Concluídas aparecem aqui'));
    tasks.forEach((t) => {
      const li = el('li', 'ag-task');
      li.draggable = true;
      li.dataset.id = t.id;
      const text = el('span', 'ag-text', t.text);
      text.title = 'Duplo clique para editar';
      text.addEventListener('dblclick', () => {
        text.contentEditable = 'true';
        text.focus();
        document.getSelection().selectAllChildren(text);
      });
      text.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); text.blur(); } });
      text.addEventListener('blur', () => {
        if (text.contentEditable !== 'true') return;
        text.contentEditable = 'false';
        if (text.textContent.trim() && text.textContent.trim() !== t.text) J.agendaOp({ op: 'task-update', id: t.id, changes: { text: text.textContent.trim() } }).then(loadAgenda);
      });
      li.append(text);
      const meta = el('div', 'ag-meta');
      if (t.due) {
        const late = status !== 'done' && t.due < today;
        meta.append(el('span', `ag-due${late ? ' late' : ''}`, (late ? 'atrasada · ' : '') + new Date(t.due + 'T00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })));
      }
      if (t.project) meta.append(el('span', 'pr-chip', t.project));
      const next = { todo: ['doing', '▶ fazer'], doing: ['done', '✓ concluir'], done: ['todo', '↺ reabrir'] }[status];
      meta.append(button(next[1], 'mini', () => J.agendaOp({ op: 'task-update', id: t.id, changes: { status: next[0] } }).then(loadAgenda)));
      meta.append(button('✕', 'mini danger', () => J.agendaOp({ op: 'task-delete', id: t.id }).then(loadAgenda), 'Apagar'));
      li.append(meta);
      li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', t.id); li.classList.add('dragging'); });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      list.append(li);
    });
  });
}

// Arrastar entre colunas
document.querySelectorAll('.ag-col').forEach((col) => {
  col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
  col.addEventListener('dragleave', () => col.classList.remove('over'));
  col.addEventListener('drop', (e) => {
    e.preventDefault();
    col.classList.remove('over');
    const id = e.dataTransfer.getData('text/plain');
    if (id) J.agendaOp({ op: 'task-update', id, changes: { status: col.dataset.status } }).then(loadAgenda);
  });
});

$('agAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('agAddText').value.trim();
  if (!text) return;
  await J.agendaOp({ op: 'task-add', text, due: $('agAddDue').value || null });
  $('agAddText').value = '';
  $('agAddDue').value = '';
  loadAgenda();
});

function renderNotes() {
  const q = normalize($('agNoteSearch').value.trim());
  const ul = $('agNotes');
  ul.innerHTML = '';
  const notes = agenda2.notes.filter((n) => !q || normalize(n.text).includes(q));
  if (!notes.length) ul.append(el('li', 'muted', q ? 'Nada encontrado.' : 'Nenhuma nota. Diga "anota que..." ou escreva acima.'));
  notes.forEach((n) => {
    const li = el('li');
    li.append(el('span', '', n.text), el('small', 'muted', new Date(n.at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })));
    li.append(button('✕', 'mini danger', () => J.agendaOp({ op: 'note-delete', id: n.id }).then(loadAgenda), 'Apagar nota'));
    ul.append(li);
  });
}
$('agNoteSearch').addEventListener('input', renderNotes);
$('agNoteAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('agNoteText').value.trim();
  if (!text) return;
  await J.agendaOp({ op: 'note-add', text });
  $('agNoteText').value = '';
  loadAgenda();
});

function renderAgendaReminders() {
  const ul = $('agReminders');
  ul.innerHTML = '';
  if (!agenda2.reminders.length) { ul.append(el('li', 'muted', 'Nenhum lembrete. Diga "me lembra de... em 10 minutos".')); return; }
  agenda2.reminders.slice().sort((a, b) => a.at - b.at).forEach((r) => {
    const li = el('li');
    li.append(el('b', '', new Date(r.at).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })), el('span', '', r.text));
    li.append(button('Cancelar', 'danger', () => J.runTool('reminder_cancel', { id: r.id }).then(loadAgenda)));
    ul.append(li);
  });
}

function renderFocusChart() {
  const labels = [], values = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    labels.push(i === 0 ? 'hoje' : d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', ''));
    values.push(agenda2.focus[key] || 0);
  }
  const total = values.reduce((a, b) => a + b, 0);
  $('agFocusTotal').textContent = `· ${Math.floor(total / 60)}h ${total % 60}min na semana`;
  const host = $('agFocusChart');
  if (!total) { host.innerHTML = '<p class="muted">Nenhum ciclo de foco ainda. Diga "modo foco" para começar.</p>'; return; }
  drawChart(host, { kind: 'bar', title: 'Minutos de foco', labels, series: [{ name: 'Minutos', values }], unit: 'min', size: 'medium' });
}

J.onTasks(() => { if (currentScreen === 'agenda') loadAgenda(); });
J.onReminders(() => { if (currentScreen === 'agenda') loadAgenda(); });
hooks.agenda = { enter: loadAgenda };

// ------------------------------------------------------------ MEMÓRIA

const TOOL_LABELS = {
  music_play: 'Tocar música', music_control: 'Controlar música', music_now_playing: 'Que música é essa', music_volume: 'Volume da música',
  get_weather: 'Clima', get_news: 'Notícias', web_search: 'Pesquisar', open_app: 'Abrir programa', open_url: 'Abrir site', open_search: 'Pesquisar no navegador',
  reminder_create: 'Lembretes', task_add: 'Tarefas', task_done: 'Concluir tarefa', note_add: 'Notas', note_search: 'Buscar notas',
  git_status: 'Git status', git_changes: 'Mudanças no código', git_commit: 'Commits', github_activity: 'GitHub', project_open: 'Abrir projeto',
  explain_clipboard: 'Explicar erro', look_at_screen: 'Olhar a tela', camera_look: 'Olhar pela câmera', briefing_show: 'Briefing',
  focus_start: 'Modo foco', show_visual: 'Respostas visuais', currency_chart: 'Câmbio', memory_remember: 'Lembrar de você', open_screen: 'Navegar',
};

let memData = { facts: [], conversations: [] };

async function loadMemory() {
  memData = await J.memoryData();
  renderFacts();
  renderConversations();
  renderToolChart();
}

function renderFacts() {
  const ul = $('meFacts');
  ul.innerHTML = '';
  $('meFactCount').textContent = memData.facts.length ? `· ${memData.facts.length}` : '';
  if (!memData.facts.length) {
    ul.append(el('li', 'muted', 'Ainda não sei nada sobre você. Conte suas preferências numa conversa ("eu prefiro...", "lembra que...") ou escreva acima.'));
    return;
  }
  memData.facts.slice().reverse().forEach((f, i) => {
    const li = el('li', 'me-fact');
    li.style.animationDelay = `${i * 40}ms`;
    li.append(el('span', '', f.text), el('small', 'muted', `${f.source === 'manual' ? 'você ensinou' : 'aprendido na conversa'} · ${new Date(f.at).toLocaleDateString('pt-BR')}`));
    li.append(button('Esquecer', 'mini danger', () => J.memoryOp({ op: 'remove', id: f.id }).then(loadMemory)));
    ul.append(li);
  });
}

$('meAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('meAddText').value.trim();
  if (!text) return;
  await J.memoryOp({ op: 'add', text });
  $('meAddText').value = '';
  loadMemory();
});

function renderConversations() {
  const q = normalize($('meSearch').value.trim());
  const box = $('meConvs');
  box.innerHTML = '';
  const convs = memData.conversations.filter((c) => !q || normalize(`${c.user} ${c.reply}`).includes(q)).reverse();
  $('meConvCount').textContent = memData.conversations.length ? `· ${memData.conversations.length}` : '';
  if (!convs.length) { box.append(el('p', 'muted', q ? 'Nada encontrado.' : 'As conversas aparecem aqui a partir de agora.')); return; }
  let lastDay = '';
  convs.slice(0, 200).forEach((c) => {
    const day = new Date(c.at).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    if (day !== lastDay) { box.append(el('h4', 'me-day', day)); lastDay = day; }
    const item = el('div', 'me-conv');
    const top = el('div', 'me-conv-top');
    top.append(el('small', 'muted', new Date(c.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })), el('b', '', c.user));
    item.append(top, el('p', '', c.reply));
    if (c.tools?.length) {
      const tl = el('div', 'me-conv-tools');
      [...new Set(c.tools)].forEach((t) => tl.append(el('span', 'pr-chip', TOOL_LABELS[t] || t)));
      item.append(tl);
    }
    box.append(item);
  });
}
$('meSearch').addEventListener('input', debounce(renderConversations, 150));
$('meClear').addEventListener('click', async () => {
  if (!confirm('Apagar o registro de conversas? A memória sobre você (fatos) continua.')) return;
  await J.memoryOp({ op: 'clear-log' });
  loadMemory();
});

function renderToolChart() {
  const counts = {};
  memData.conversations.forEach((c) => [...new Set(c.tools || [])].forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const host = $('meToolChart');
  if (!top.length) { host.innerHTML = '<p class="muted">Ainda sem dados suficientes.</p>'; return; }
  drawChart(host, { kind: 'bar', title: 'Pedidos', labels: top.map(([t]) => TOOL_LABELS[t] || t), series: [{ name: 'Vezes', values: top.map(([, n]) => n) }], size: 'medium' });
}

J.onMemory(() => { if (currentScreen === 'memory') loadMemory(); });
hooks.memory = { enter: loadMemory };

// ------------------------------------------------------------ PESQUISAS

const rs = { list: [], selected: null, live: null };
const TYPE_ICON = { research: '⌕', compare: '⚖', link: '🔗' };
const TYPE_LABEL = { research: 'PESQUISA', compare: 'COMPARAÇÃO', link: 'LINK' };
const favicon = (host) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;

async function loadResearchList() {
  rs.list = await J.researchList();
  renderResearchList();
}

function renderResearchList() {
  const q = normalize($('rsSearch').value.trim());
  const ul = $('rsList');
  ul.innerHTML = '';
  $('rsCount').textContent = rs.list.length ? `· ${rs.list.length}` : '';
  const items = rs.list.filter((it) => !q || normalize(`${it.title} ${it.summary}`).includes(q));
  if (!items.length) ul.append(el('li', 'muted rs-empty', q ? 'Nada encontrado.' : 'Nenhuma pesquisa ainda.'));
  items.forEach((it) => {
    const li = el('li', `rs-item${rs.selected === it.id ? ' active' : ''}`);
    li.append(el('span', 'rs-icon', TYPE_ICON[it.type] || '•'));
    const txt = el('div');
    txt.append(el('b', '', it.title), el('small', 'muted', `${new Date(it.at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}${it.sources ? ` · ${it.sources} fontes` : ''}`));
    li.append(txt);
    li.append(button('✕', 'mini danger rs-del', async (e) => {
      e.stopPropagation();
      if (!confirm(`Apagar "${it.title}"?`)) return;
      await J.researchDelete(it.id);
      if (rs.selected === it.id) { rs.selected = null; renderResearchEmpty(); }
      loadResearchList();
    }, 'Apagar'));
    li.addEventListener('click', () => openResearch(it.id));
    ul.append(li);
  });
}
$('rsSearch').addEventListener('input', renderResearchList);

function renderResearchEmpty() {
  const v = $('rsView');
  v.innerHTML = '';
  const box = el('div', 'rs-empty-view');
  box.append(el('div', 'rs-big-icon', '⌕'), el('h2', '', 'Pesquisa com o JARVIS'));
  [['⌕', '"Pesquisa a fundo sobre o mercado de drones no Brasil"', 'lê várias páginas e monta um relatório com fontes'],
    ['⚖', '"Compara FastAPI, Flask e Django para o CAMPEX"', 'tabela, notas, prós e contras e veredito (com dados reais do PyPI/npm/GitHub)'],
    ['🔗', '"Resume esse link" (com um link copiado)', 'lê a página e resume os pontos principais'],
    ['◉', '"Quem foi Nikola Tesla?"', 'card com foto e resumo']].forEach(([i, ex, d]) => {
    const row = el('div', 'rs-example');
    row.append(el('span', 'rs-icon', i));
    const t = el('div');
    t.append(el('b', '', ex), el('small', 'muted', d));
    row.append(t);
    box.append(row);
  });
  v.append(box);
}

// Texto com citações [n] → números clicáveis que abrem a fonte
function cited(text, sources) {
  const p = el('p');
  String(text || '').split(/(\[\d+(?:,\s*\d+)*\])/).forEach((part) => {
    const m = part.match(/^\[(\d+(?:,\s*\d+)*)\]$/);
    if (!m) { p.append(part); return; }
    m[1].split(/,\s*/).forEach((n) => {
      const src = sources.find((s) => s.n === Number(n));
      const sup = el('sup', 'rs-cite', n);
      if (src) { sup.title = `${src.title} (${src.host})`; sup.onclick = () => J.openExternal(src.url); }
      p.append(sup);
    });
  });
  return p;
}

function sourcesList(sources) {
  const ol = el('ol', 'rs-sources');
  sources.forEach((s) => {
    const li = el('li');
    const img = el('img');
    img.src = favicon(s.host);
    img.alt = '';
    li.append(el('span', 'rs-n', String(s.n)), img);
    const t = el('div');
    t.append(el('b', '', s.title), el('small', 'muted', s.host));
    li.append(t);
    li.onclick = () => J.openExternal(s.url);
    ol.append(li);
  });
  return ol;
}

async function openResearch(id) {
  rs.selected = id;
  rs.live = null;
  renderResearchList();
  const item = await J.researchGet(id);
  if (item) renderResearchItem(item);
}

function renderResearchItem(item) {
  const v = $('rsView');
  v.innerHTML = '';
  v.scrollTop = 0;
  const head = el('header', 'rs-head');
  head.append(el('span', 'bf-kicker', `${TYPE_LABEL[item.type] || ''} · ${new Date(item.at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}${item.sources?.length ? ` · ${item.sources.length} fontes` : ''}`));
  head.append(el('h2', '', item.title));
  v.append(head);

  if (item.image && item.type === 'link') { const img = el('img', 'rs-hero'); img.src = item.image; img.onerror = () => img.remove(); v.append(img); }
  if (item.tldr) v.append(el('div', 'rs-tldr', item.tldr));
  if (item.answer) { const a = el('div', 'rs-summary'); a.append(el('b', '', 'Resposta: '), item.answer); v.append(a); }
  if (item.summary) { const s = el('div', 'rs-summary'); s.append(cited(item.summary, item.sources || [])); v.append(s); }

  if (item.keyPoints?.length) {
    const box = el('section', 'card rs-points');
    box.append(el('h3', '', 'PONTOS-CHAVE'));
    const ul = el('ul');
    item.keyPoints.forEach((k) => { const li = el('li'); li.append(cited(k, item.sources || [])); ul.append(li); });
    box.append(ul);
    v.append(box);
  }

  if (item.type === 'compare' && item.cards?.length) {
    const grid = el('div', 'rs-cards');
    const cards = item.cards.map(buildVisualCard);
    cards.forEach((c, i) => { grid.append(c); setTimeout(() => c.classList.add('in'), 80 * i); });
    v.append(grid);
    cards.forEach((c) => c.onMount && c.onMount());
  }

  (item.sections || []).forEach((sec) => {
    const s = el('section', 'rs-section');
    s.append(el('h3', '', sec.heading));
    String(sec.text || '').split(/\n{2,}|\n(?=\S)/).filter((t) => t.trim()).forEach((para) => s.append(cited(para, item.sources || [])));
    v.append(s);
  });
  if (item.gaps) { const g = el('div', 'rs-gaps'); g.append(el('b', '', 'O que não deu para confirmar: '), item.gaps); v.append(g); }

  if (item.sources?.length) {
    const s = el('section', 'rs-section');
    s.append(el('h3', '', 'FONTES'), sourcesList(item.sources));
    v.append(s);
  }
}

// Progresso ao vivo (fontes sendo lidas)
const PHASE_TEXT = { plan: 'Planejando a pesquisa...', search: 'Buscando na internet...', reading: 'Lendo as fontes', writing: 'Escrevendo o relatório...', error: 'Algo deu errado' };
function renderLive(p) {
  const v = $('rsView');
  v.innerHTML = '';
  const box = el('div', 'rs-live');
  box.append(el('span', 'bf-kicker', 'PESQUISANDO AGORA'), el('h2', '', rs.live.topic || 'Pesquisa'));
  const total = p.sources?.length || 0, done = (p.sources || []).filter((s) => s.status === 'done' || s.status === 'failed').length;
  const phase = el('div', 'rs-phase');
  phase.append(el('i', 'rs-spin'), el('span', '', p.phase === 'reading' ? `${PHASE_TEXT.reading} · ${done} de ${total}` : (p.message || PHASE_TEXT[p.phase] || '')));
  box.append(phase);
  const bar = el('div', 'bar');
  const fill = el('i');
  fill.style.width = `${{ plan: 8, search: 18, reading: 20 + (total ? (done / total) * 60 : 0), writing: 88 }[p.phase] || 0}%`;
  bar.append(fill);
  box.append(bar);
  if (p.queries?.length || rs.live.queries) {
    rs.live.queries = p.queries || rs.live.queries;
    const qs = el('div', 'rs-queries');
    rs.live.queries.forEach((q) => qs.append(el('span', 'pr-chip', q)));
    box.append(qs);
  }
  const ul = el('ul', 'rs-live-sources');
  (p.sources || []).forEach((s) => {
    const li = el('li', `st-${s.status}`);
    const img = el('img');
    img.src = favicon(s.host);
    img.alt = '';
    li.append(el('span', 'rs-status', { pending: '○', reading: '◌', done: '✓', failed: '✗' }[s.status] || '○'), img);
    const t = el('div');
    t.append(el('b', '', s.title || s.host), el('small', 'muted', s.status === 'failed' ? `${s.host} · não deu para ler` : s.host));
    li.append(t);
    ul.append(li);
  });
  box.append(ul);
  v.append(box);
}

J.onResearchProgress((p) => {
  if (p.phase === 'done') {
    rs.live = null;
    rs.selected = p.item.id;
    loadResearchList();
    if (currentScreen === 'research') renderResearchItem(p.item);
    return;
  }
  if (!rs.live || rs.live.id !== p.id) rs.live = { id: p.id, topic: p.topic };
  if (p.topic) rs.live.topic = p.topic;
  if (currentScreen === 'research') renderLive(p);
  rs.live.last = p;
});
J.onResearchSaved(() => { if (currentScreen === 'research') loadResearchList(); });

hooks.research = {
  enter() {
    loadResearchList();
    if (rs.live?.last) renderLive(rs.live.last);
    else if (rs.selected) openResearch(rs.selected);
    else renderResearchEmpty();
  },
};

// ------------------------------------------------------------ OFICINA

let oficina = null; // instância montada na aba (a janela dedicada tem a sua)

async function showOficinaHere() {
  const { windowOpen } = await J.oficinaStatus();
  $('oficinaElsewhere').hidden = !windowOpen;
  $('oficinaMount').hidden = windowOpen;
  if (windowOpen) { oficina?.pause(); return; }
  if (!oficina) {
    // o módulo da Oficina carrega de forma assíncrona; espera ele ficar disponível
    for (let i = 0; i < 50 && !window.Oficina; i++) await new Promise((r) => setTimeout(r, 100));
    oficina = window.Oficina.mount($('oficinaMount'));
  } else oficina.resume();
}

J.onOficinaWindow(() => { if (currentScreen === 'oficina') showOficinaHere(); });
$('oficinaFocus').addEventListener('click', () => J.oficinaWindow(true));
$('oficinaCloseWin').addEventListener('click', () => J.oficinaWindow(false));
hooks.oficina = { enter: showOficinaHere, leave: () => oficina?.pause() };

// ------------------------------------------------------------ CONFIGURAÇÕES

const form = $('settingsForm');

async function loadSettings() {
  const cfg = await J.getConfig();
  for (const field of form.elements) {
    if (!field.name || !(field.name in cfg)) continue;
    if (field.type === 'checkbox') field.checked = cfg[field.name] !== false;
    else field.value = cfg[field.name] ?? '';
  }
  $('wakeVal').textContent = form.wakeThreshold.value;

  const skills = await J.skillsList();
  const ul = $('stSkills');
  ul.innerHTML = '';
  skills.forEach((s) => {
    const li = el('li');
    const label = el('label', 'check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = s.enabled;
    cb.dataset.skill = s.name;
    label.append(cb, `${s.label}`, el('small', 'muted', ` · ${s.tools} comandos`));
    li.append(label);
    ul.append(li);
  });

  renderTelegram(await J.telegramStatus());

  const disks = await J.diskInfo();
  const dl = $('stDisks');
  dl.innerHTML = '';
  disks.forEach((d) => {
    const li = el('li');
    if (d.error) { li.append(el('b', '', d.drive), el('span', 'muted', 'indisponível')); dl.append(li); return; }
    const freeGb = d.free / 1e9, usedPct = 100 - (d.free / d.total) * 100;
    const critical = freeGb < 2;
    li.append(el('b', '', d.drive), el('span', critical ? 'warn' : '', `${freeGb.toFixed(freeGb < 10 ? 2 : 0)} GB livres de ${(d.total / 1e9).toFixed(0)} GB`));
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = `${usedPct}%`;
    if (critical) fill.classList.add('hot');
    bar.append(fill);
    li.append(bar);
    if (critical) li.append(el('small', 'warn', 'Disco praticamente cheio: o Windows e outros programas podem falhar.'));
    dl.append(li);
  });
}

function renderTelegram(t) {
  const box = $('stTelegram');
  box.innerHTML = '';
  if (t.status === 'off') { box.append(el('span', 'muted', 'Desligado.')); return; }
  if (t.status === 'error') { box.append(el('span', 'warn', `Erro: ${t.error}`)); return; }
  if (t.status === 'waiting') {
    box.append(el('div', '', `Bot ${t.bot} ligado. Mande este código para ele no Telegram:`), el('div', 'code', t.code));
    // confere a cada 3 s se o pareamento já aconteceu
    clearTimeout(renderTelegram.timer);
    renderTelegram.timer = setTimeout(async () => { if (currentScreen === 'settings') renderTelegram(await J.telegramStatus()); }, 3000);
    return;
  }
  box.append(el('span', 'ok', `✓ Pareado com ${t.user || 'você'} (${t.bot || 'bot'}). `));
  box.append(button('Desparear', 'mini danger', async () => {
    if (!confirm('Desparear o Telegram? Vai ser preciso mandar um novo código.')) return;
    renderTelegram(await J.telegramUnpair());
  }));
}

$('btnPhonePair').addEventListener('click', () => J.phonePair().then((r) => {
  if (r?.already_connected) toast('O celular já está conectado.');
  else if (r && !r.ok) toast(r.error, 'error');
}));

form.wakeThreshold.addEventListener('input', () => { $('wakeVal').textContent = form.wakeThreshold.value; });
$('getKey').addEventListener('click', (e) => { e.preventDefault(); J.openExternal('https://build.nvidia.com/settings/api-keys'); });
$('btnModels').addEventListener('click', async () => {
  const btn = $('btnModels');
  btn.textContent = '...';
  try {
    const models = await J.listModels(form.apiKey.value.trim());
    $('models').innerHTML = '';
    models.forEach((m) => { const o = el('option'); o.value = m; $('models').append(o); });
    toast(`${models.length} modelos Nemotron disponíveis. Clique no campo para escolher.`);
  } catch {
    toast('Não consegui listar os modelos. Confira a chave.', 'error');
  }
  btn.textContent = 'listar';
});

// Captura de atalho: clique no campo e pressione a combinação
document.querySelectorAll('.hotkey').forEach((input) => {
  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    if (!mods.length) { toast('Use pelo menos uma tecla modificadora (Ctrl, Alt ou Shift).', 'error'); return; }
    const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d+$/.test(e.key) ? e.key : e.key === ' ' ? 'Space' : null;
    if (!key) return;
    input.value = [...mods, key].join('+');
  });
});

$('btnTestVoice').addEventListener('click', async () => {
  await J.saveConfig({ voice: form.voice.value });
  audioCtx.resume();
  J.testVoice();
});
$('btnYtmReauth').addEventListener('click', async () => {
  toast('Confirme o pedido de acesso na janela do YouTube Music.');
  const r = await J.ytmReauth();
  toast(r.ok ? 'YouTube Music autorizado.' : r.error, r.ok ? 'ok' : 'error');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = (name) => form.elements[name].value.trim();
  await J.saveConfig({
    apiKey: v('apiKey'),
    model: v('model'),
    visionModel: v('visionModel'),
    userName: v('userName') || 'senhor',
    city: v('city'),
    projectsDir: v('projectsDir'),
    githubToken: v('githubToken'),
    voice: form.voice.value,
    whisperModel: form.whisperModel.value,
    wakeThreshold: parseFloat(form.wakeThreshold.value),
    followUp: form.followUp.checked,
    hotkeyListen: v('hotkeyListen'),
    hotkeyToggle: v('hotkeyToggle'),
    miniOrb: form.miniOrb.checked,
    ytmPath: v('ytmPath'),
    bargeIn: form.bargeIn.checked,
    voiceFx: form.voiceFx.checked,
    bootGreeting: form.bootGreeting.checked,
    telegramToken: v('telegramToken'),
    telegramAlerts: form.telegramAlerts.checked,
    disabledSkills: [...document.querySelectorAll('#stSkills input')].filter((cb) => !cb.checked).map((cb) => cb.dataset.skill),
  });
  toast('Configurações salvas.');
  voiceFxEnabled = form.voiceFx.checked;
  setTimeout(async () => renderTelegram(await J.telegramStatus()), 1500); // o bot reinicia ao trocar o token
});

hooks.settings = { enter: loadSettings };

// Primeira vez: sem chave da NVIDIA, abre as configurações
J.getConfig().then((cfg) => {
  if (!cfg.hasKey) setTimeout(() => { go('settings'); toast('Bem-vindo. Configure sua chave da API NVIDIA para começar.'); }, 2700);
});
