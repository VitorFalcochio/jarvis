// Oficina: o local de trabalho das agentes de código (FRIDAY, EDITH, KAREN).
// Cada agente tem uma baia com avatar, progresso, o que está fazendo ao vivo e as ações (diff, aplicar, ajustar).
// O mesmo código roda na aba "Oficina" do JARVIS e na janela dedicada (oficina.html, no segundo monitor).

const J = window.jarvis;

const TEMPLATE = `
  <header class="of-head">
    <div class="of-brand"><img src="assets/icon.png" alt="">J.A.R.V.I.S. <b>· OFICINA</b></div>
    <div class="of-voice" data-ref="voice">EM ESPERA</div>
    <div class="of-team" data-ref="team"></div>
    <div class="of-clock" data-ref="clock">--:--</div>
    <div class="of-actions" data-ref="actions"></div>
  </header>
  <div class="of-bays" data-ref="bays"></div>
  <footer class="of-foot">
    <div class="of-sys"><label>CPU</label><b data-ref="cpu">--%</b><canvas data-ref="cpuChart"></canvas><label>RAM</label><b data-ref="ram">--%</b></div>
    <div class="of-music">
      <img data-ref="cover" alt="">
      <div class="of-song"><b data-ref="song">Nada tocando</b><small data-ref="artist" class="muted"></small></div>
      <button data-music="previous">⏮</button><button data-music="toggle" data-ref="toggle">▶</button><button data-music="next">⏭</button>
    </div>
    <div class="of-ticker"><div class="of-ticker-track" data-ref="ticker"></div></div>
  </footer>
  <div class="of-modal" data-ref="modal" hidden><div class="of-dialog" data-ref="dialog"></div></div>`;

// Avatares: cada agente tem um rosto geométrico próprio (a cor vem de --ag)
const AVATARS = {
  friday: `<circle class="core" cx="50" cy="50" r="30"/>
    <circle class="ring" cx="50" cy="50" r="46" stroke-dasharray="20 8"/>
    <circle class="face" cx="50" cy="50" r="33"/>
    <path class="eye" d="M33 46h11M56 46h11"/>
    <path class="mouth" d="M40 61q10 7 20 0"/>`,
  edith: `<circle class="core" cx="50" cy="50" r="30"/>
    <circle class="ring" cx="50" cy="50" r="46" stroke-dasharray="3 6"/>
    <polygon class="face" points="50,15 80,32 80,68 50,85 20,68 20,32"/>
    <path class="eye" d="M29 44h17l-3 9h-11zM54 44h17l-3 9h-11zM46 46h8"/>
    <path class="mouth" d="M42 66h16"/>`,
  karen: `<circle class="core" cx="50" cy="50" r="30"/>
    <circle class="ring" cx="50" cy="50" r="46" stroke-dasharray="32 6 4 6"/>
    <polygon class="face" points="50,14 86,50 50,86 14,50"/>
    <circle class="eye" cx="41" cy="47" r="4"/><circle class="eye" cx="59" cy="47" r="4"/>
    <path class="mouth" d="M43 61h14"/>`,
};
const avatar = (id) => `<svg viewBox="0 0 100 100" class="of-avatar">${AVATARS[id] || AVATARS.friday}</svg>`;

const STATUS = {
  running: ['TRABALHANDO', 'busy'], done: ['ESPERANDO APROVAÇÃO', 'alert'], failed: ['FALHOU', 'fail'],
  accepted: ['APLICADO', 'ok'], discarded: ['DESCARTADO', 'muted'], idle: ['DISPONÍVEL', 'idle'],
};
const PHASES = { preparando: '⎇ Preparando', analisando: '🔎 Analisando o código', escrevendo: '✏ Escrevendo código', testando: '▶ Testando', revisando: '📦 Empacotando o diff', pronto: '✔ Pronto' };

const brl = (v, d = 2) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
// Markdown mínimo do resumo das agentes (**negrito** e `código`), montado sem innerHTML
function richText(box, text) {
  text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).forEach((part) => {
    if (/^\*\*.+\*\*$/.test(part)) box.append(Object.assign(document.createElement('strong'), { textContent: part.slice(2, -2) }));
    else if (/^`.+`$/.test(part)) box.append(Object.assign(document.createElement('code'), { textContent: part.slice(1, -1) }));
    else box.append(part);
  });
  return box;
}
function progressOf(job) {
  if (['done', 'accepted'].includes(job.status)) return 100;
  if (job.status !== 'running') return 0;
  return Math.max(3, Math.round(95 * (1 - Math.exp(-(job.iter || 0) / (job.expected || 16)))));
}

export function mountOficina(root, { standalone = false } = {}) {
  root.classList.add('of');
  root.innerHTML = TEMPLATE;
  const $ = (name) => root.querySelector(`[data-ref="${name}"]`);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const btn = (label, cls, onClick, title) => { const b = el('button', `of-btn ${cls || ''}`, label); b.onclick = onClick; if (title) b.title = title; return b; };
  const unsub = [];
  const timers = {};
  let active = false;
  let team = { agents: [], jobs: [] };
  const bays = new Map(); // agent.id → { root, refs }
  const cpuHist = [];

  // ---- cabeçalho
  const actions = $('actions');
  actions.append(btn('＋ Nova tarefa', 'primary', () => openNewTask()));
  if (standalone) {
    actions.append(btn('✕', '', () => window.close(), 'Fechar (Esc)'));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('modal').hidden) window.close(); });
  } else {
    const w = btn('⧉ Abrir em janela', '', () => J.oficinaWindow(true), 'Abrir em tela cheia no segundo monitor');
    w.dataset.ref = 'winBtn';
    actions.append(w);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

  const VOICE = { idle: 'EM ESPERA', wake: 'À DISPOSIÇÃO', listening: 'OUVINDO', processing: 'PROCESSANDO', thinking: 'PENSANDO', searching: 'CONSULTANDO', speaking: 'FALANDO', offline: 'VOZ OFFLINE', loading: 'CARREGANDO' };
  unsub.push(J.onVoiceStatus(({ state }) => {
    $('voice').textContent = VOICE[state] || state.toUpperCase();
    $('voice').className = `of-voice ${state}`;
  }));

  // ---- baias
  // trabalho mostrado na baia: o mais recente da agente que ainda não foi dispensado
  const jobOf = (agentId) => team.jobs.filter((j) => j.agent === agentId && !j.hidden && j.status !== 'discarded').pop() || null;

  function buildBays() {
    const box = $('bays');
    box.innerHTML = '';
    bays.clear();
    team.agents.forEach((a, i) => {
      const sec = el('section', 'of-bay');
      sec.style.setProperty('--ag', a.color);
      sec.style.animationDelay = `${i * 0.1}s`;
      sec.innerHTML = `
        <div class="of-bay-head">
          ${avatar(a.id)}
          <div class="of-who"><h2>${a.name}</h2><small>${a.role}</small></div>
          <span class="of-chip" data-b="chip"></span>
        </div>
        <div class="of-bay-body" data-b="body"></div>`;
      const refs = (n) => sec.querySelector(`[data-b="${n}"]`);
      box.append(sec);
      bays.set(a.id, { sec, refs, agent: a, shown: null });
    });
    team.agents.forEach((a) => renderBay(a.id));
    renderTeam();
  }

  function renderTeam() {
    const running = team.jobs.filter((j) => j.status === 'running').length;
    const waiting = team.jobs.filter((j) => j.status === 'done' && j.files?.length && !j.hidden).length;
    const free = team.agents.length - team.agents.filter((a) => { const j = jobOf(a.id); return j && (j.status === 'running' || (j.status === 'done' && j.files?.length)); }).length;
    $('team').innerHTML = '';
    $('team').append(
      el('span', running ? 'busy' : '', `● ${running} trabalhando`),
      el('span', waiting ? 'alert' : '', `● ${waiting} esperando você`),
      el('span', 'ok', `● ${free} livre${free === 1 ? '' : 's'}`),
    );
  }

  function renderBay(agentId) {
    const bay = bays.get(agentId);
    if (!bay) return;
    const job = jobOf(agentId);
    const state = job ? job.status : 'idle';
    const [label, cls] = STATUS[state] || [state, ''];
    bay.sec.dataset.state = state;
    const chip = bay.refs('chip');
    chip.textContent = label;
    chip.className = `of-chip ${cls}`;
    const body = bay.refs('body');
    // feed: atualiza só o que mudou, para não perder a rolagem
    if (bay.shown === job?.id && job?.status === 'running' && bay.lastStatus === 'running') { updateRunning(bay, job); return; }
    bay.shown = job?.id || null;
    bay.lastStatus = job?.status;
    body.innerHTML = '';

    if (!job || state === 'accepted') {
      const idle = el('div', 'of-idle');
      idle.append(el('p', '', 'Disponível para uma nova tarefa.'));
      if (job) idle.append(el('small', 'muted', `Último trabalho: ${job.project} ✅ aplicado`));
      idle.append(btn('＋ Dar uma tarefa', 'primary', () => openNewTask(agentId)));
      body.append(idle);
      if (job) bay.sec.dataset.state = 'idle';
      chip.textContent = STATUS.idle[0];
      chip.className = 'of-chip idle';
      return;
    }

    const head = el('div', 'of-job');
    head.append(el('b', job.lab ? 'of-lab-tag' : '', job.lab ? '🧪 LABORATÓRIO · protótipo ao vivo' : job.project), el('p', '', job.task));
    if (job.adjustments) head.append(el('small', 'muted', `${job.adjustments} ajuste${job.adjustments > 1 ? 's' : ''}`));
    body.append(head);

    const prog = el('div', 'of-progress');
    prog.append(el('i'));
    const meta = el('div', 'of-meta');
    meta.append(el('span', 'of-phase'), el('span', 'of-files'), el('span', 'of-elapsed'));
    body.append(prog, meta);

    if (job.status === 'running') {
      const feed = el('ol', 'of-feed');
      body.append(feed);
      const acts = el('div', 'of-bay-actions');
      if (job.lab) {
        acts.append(btn('Abrir protótipo ↗', 'primary', () => labAct('open')));
        acts.append(btn('Encerrar', 'danger', () => labAct('close', {}, 'Encerrar o laboratório e apagar o protótipo?')));
      } else acts.append(btn('Cancelar', 'danger', () => act('discard', job, 'Cancelar o trabalho e apagar a cópia?')));
      body.append(acts);
      bay.feedCount = 0;
      updateRunning(bay, job);
      return;
    }

    fillMeta(bay, job);
    if (job.error) body.append(el('div', 'of-error', job.error));
    if (job.summary) body.append(richText(el('div', 'of-summary'), job.summary));
    if (job.files?.length) {
      const files = el('ul', 'of-filelist');
      job.files.slice(0, 40).forEach((f) => {
        const [st, ...name] = f.split('\t');
        const li = el('li');
        li.append(el('span', `of-st st-${st[0]}`, { A: '+', M: '~', D: '−', R: '→' }[st[0]] || st[0]), el('span', '', name.join(' → ')));
        files.append(li);
      });
      if (job.files.length > 40) files.append(el('li', 'muted', `... +${job.files.length - 40}`));
      body.append(files);
    }
    const acts = el('div', 'of-bay-actions');
    if (job.lab) {
      acts.append(btn('Abrir protótipo ↗', 'primary', () => labAct('open')));
      acts.append(btn('↻ Mudar', '', () => openAdjust(job)));
      acts.append(btn('Salvar como projeto', '', () => openKeep()));
      acts.append(btn('Encerrar', 'danger', () => labAct('close', {}, 'Encerrar o laboratório e apagar o protótipo?')));
    } else if (job.status === 'done' && job.files?.length) {
      acts.append(btn('✓ Aplicar', 'primary', () => act('accept', job, `Aplicar ${job.files.length} arquivo(s) no ${job.project}?`)));
      acts.append(btn('Ver diff', '', () => openDiff(job)));
      acts.append(btn('↻ Ajustar', '', () => openAdjust(job)));
      acts.append(btn('VS Code', '', () => J.agentAction('open', { id: job.id }), 'Abrir a cópia de trabalho no VS Code'));
      acts.append(btn('Descartar', 'danger', () => act('discard', job, 'Descartar o trabalho da agente?')));
    } else {
      if (job.status === 'failed') acts.append(btn('↻ Tentar de novo / ajustar', '', () => openAdjust(job)));
      if (job.status === 'failed') acts.append(btn('Descartar', 'danger', () => act('discard', job, 'Descartar o trabalho da agente?')));
      else acts.append(btn('Dispensar', '', () => act('clear', job)));
    }
    body.append(acts);
  }

  function fillMeta(bay, job) {
    const body = bay.refs('body');
    body.querySelector('.of-progress i').style.width = `${progressOf(job)}%`;
    body.querySelector('.of-phase').textContent = job.status === 'running' ? (PHASES[job.phase] || job.phase || '') : job.status === 'failed' ? '✗ Falhou' : '✔ Concluído';
    const files = new Set(job.steps.filter((s) => s.file).map((s) => s.file));
    const n = job.files?.length || files.size;
    body.querySelector('.of-files').textContent = n ? `📝 ${n} arquivo${n > 1 ? 's' : ''}` : '';
    body.querySelector('.of-elapsed').textContent = `⏱ ${clock((job.finishedAt || Date.now()) - job.startedAt)}`;
  }

  function updateRunning(bay, job) {
    fillMeta(bay, job);
    const feed = bay.refs('body').querySelector('.of-feed');
    if (!feed) return;
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    const steps = job.steps.slice(-60);
    feed.innerHTML = '';
    steps.forEach((s, i) => {
      const li = el('li', `${s.running ? 'running' : s.ok === false ? 'fail' : s.ok ? 'pass' : ''} ${s.icon === '💭' ? 'thought' : ''} ${s.adjust ? 'adjust' : ''}`);
      if (i === steps.length - 1 && job.steps.length !== bay.feedCount) li.classList.add('new');
      li.append(el('span', 'of-ic', s.running ? '◌' : s.icon), el('span', '', s.text));
      feed.append(li);
    });
    const thinking = el('li', 'running');
    thinking.append(el('i', 'of-dots'), el('span', 'muted', 'pensando'));
    feed.append(thinking);
    if (job.steps.length !== bay.feedCount) {
      // a agente "fala" quando faz algo novo
      bay.sec.classList.remove('talk');
      void bay.sec.offsetWidth;
      bay.sec.classList.add('talk');
    }
    bay.feedCount = job.steps.length;
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
  }

  async function labAct(action, opts = {}, question) {
    if (question && !confirm(question)) return null;
    const r = await J.labAction(action, opts);
    if (r && r.ok === false) alert(r.error);
    return r;
  }

  function openKeep() {
    openModal('SALVAR COMO PROJETO', (d) => {
      const form = el('form', 'of-form');
      const name = Object.assign(el('input'), { placeholder: 'nome da pasta (ex: app-receitas)', required: true });
      const go = btn('Salvar ▸', 'primary');
      go.type = 'submit';
      const msg = el('div', 'of-error');
      msg.hidden = true;
      form.append(el('label', '', 'Nome do projeto'), name, msg, go);
      form.onsubmit = async (e) => {
        e.preventDefault();
        go.disabled = true;
        const r = await J.labAction('keep', { name: name.value });
        if (r.ok === false) { msg.textContent = r.error; msg.hidden = false; go.disabled = false; return; }
        msg.className = 'of-ok';
        msg.textContent = `Salvo em ${r.path}`;
        msg.hidden = false;
        go.hidden = true;
      };
      d.append(form);
      setTimeout(() => name.focus(), 50);
    });
  }

  async function act(action, job, question) {
    if (question && !confirm(question)) return;
    const r = await J.agentAction(action, { id: job.id });
    if (r && r.ok === false) alert(r.error);
  }

  unsub.push(J.onAgent((job) => {
    if (!job) return;
    const i = team.jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) team.jobs[i] = job; else team.jobs.push(job);
    if (!active) return;
    renderBay(job.agent);
    renderTeam();
  }));

  // ---- janelas sobrepostas: nova tarefa, diff, ajuste
  function openModal(title, build) {
    const d = $('dialog');
    d.innerHTML = '';
    const h = el('h2', '', title);
    h.append(btn('✕', 'ghost', closeModal));
    d.append(h);
    build(d);
    $('modal').hidden = false;
  }
  function closeModal() { $('modal').hidden = true; $('dialog').innerHTML = ''; }
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

  async function openNewTask(agentId) {
    const projects = (await J.projectsOverview().catch(() => [])).filter((p) => p.kinds.includes('git'));
    const busy = new Set(team.agents.filter((a) => { const j = jobOf(a.id); return j && (j.status === 'running' || (j.status === 'done' && j.files?.length)); }).map((a) => a.id));
    openModal('NOVA TAREFA', (d) => {
      const form = el('form', 'of-form');
      // agente
      const who = el('div', 'of-pick');
      let chosen = agentId || null;
      const auto = el('button', 'of-pick-opt', 'Automático');
      auto.type = 'button';
      const opts = [auto];
      team.agents.forEach((a) => {
        const b = el('button', 'of-pick-opt');
        b.type = 'button';
        b.style.setProperty('--ag', a.color);
        b.innerHTML = `${avatar(a.id)}<span>${a.short}</span>`;
        b.disabled = busy.has(a.id);
        if (b.disabled) b.title = 'Ocupada';
        b.dataset.id = a.id;
        opts.push(b);
      });
      const mark = () => opts.forEach((o) => o.classList.toggle('on', (o.dataset.id || null) === chosen));
      opts.forEach((o) => { o.onclick = () => { chosen = o.dataset.id || null; mark(); }; who.append(o); });
      mark();
      form.append(el('label', '', 'Agente'), who);

      // projeto
      const kind = el('div', 'of-seg');
      const bLab = el('button', '', '🧪 Laboratório'), bNew = el('button', 'on', 'Projeto novo'), bOld = el('button', '', 'Projeto existente');
      bLab.type = bNew.type = bOld.type = 'button';
      kind.append(bLab, bNew, bOld);
      const newName = Object.assign(el('input'), { placeholder: 'nome da pasta (ex: petshop)', required: true });
      const sel = el('select');
      projects.forEach((p) => sel.append(Object.assign(el('option', '', p.name), { value: p.name })));
      sel.hidden = true;
      const labHint = el('small', 'muted', 'Protótipo instantâneo em HTML/CSS/JS: o navegador abre e você vê a agente montando ao vivo. Nada é salvo em E:\\Projetos até você pedir.');
      labHint.hidden = true;
      let mode = 'new';
      const setMode = (m) => {
        mode = m;
        [[bLab, 'lab'], [bNew, 'new'], [bOld, 'old']].forEach(([b, k]) => b.classList.toggle('on', k === m));
        newName.hidden = m !== 'new'; newName.required = m === 'new';
        sel.hidden = m !== 'old';
        labHint.hidden = m !== 'lab';
        task.placeholder = m === 'lab' ? 'Qual é a ideia? Ex: um app para dividir a conta do bar entre amigos, com lista de itens e quem pediu o quê.' : 'O que ela deve fazer? Ex: um site de petshop com página inicial, serviços (banho e tosa), agendamento e contato. React + Vite, visual moderno.';
      };
      bLab.onclick = () => setMode('lab');
      bNew.onclick = () => setMode('new');
      bOld.onclick = () => setMode('old');
      if (!projects.length) bOld.disabled = true;
      form.append(el('label', '', 'Onde'), kind, newName, sel, labHint);

      const task = Object.assign(el('textarea'), { rows: 5, required: true });
      form.append(el('label', '', 'Tarefa'), task);
      setMode('new');

      const err = el('div', 'of-error');
      err.hidden = true;
      const go = btn('Começar ▸', 'primary');
      go.type = 'submit';
      form.append(err, go);
      form.onsubmit = async (e) => {
        e.preventDefault();
        go.disabled = true;
        go.textContent = 'Preparando...';
        const r = mode === 'lab'
          ? await J.labAction('start', { text: task.value, agent: chosen || undefined })
          : await J.agentAction('start', { text: task.value, agent: chosen || undefined, ...(mode === 'new' ? { newProject: newName.value } : { project: sel.value }) });
        if (r.ok) { closeModal(); return; }
        err.textContent = r.error;
        err.hidden = false;
        go.disabled = false;
        go.textContent = 'Começar ▸';
      };
      d.append(form);
      setTimeout(() => (agentId ? newName : newName).focus(), 50);
    });
  }

  function openAdjust(job) {
    const a = team.agents.find((x) => x.id === job.agent);
    openModal(`AJUSTE · ${a?.short || ''} · ${job.project}`, (d) => {
      const form = el('form', 'of-form');
      const text = Object.assign(el('textarea'), { rows: 4, required: true, placeholder: job.status === 'failed' ? 'Ex: continue de onde parou' : 'Ex: deixa o tema azul escuro e adiciona uma página de contato' });
      if (job.status === 'failed') text.value = 'Continue a tarefa de onde parou e termine.';
      const go = btn('Enviar ajuste ▸', 'primary');
      go.type = 'submit';
      const err = el('div', 'of-error');
      err.hidden = true;
      form.append(el('label', '', 'O que mudar?'), text, err, go);
      form.onsubmit = async (e) => {
        e.preventDefault();
        go.disabled = true;
        const r = job.lab ? await J.labAction('change', { text: text.value }) : await J.agentAction('adjust', { id: job.id, text: text.value });
        if (r.ok === false) { err.textContent = r.error; err.hidden = false; go.disabled = false; return; }
        closeModal();
      };
      d.append(form);
      setTimeout(() => text.focus(), 50);
    });
  }

  function openDiff(job) {
    openModal(`DIFF · ${job.project}`, (d) => {
      if (job.diffStat) d.append(el('pre', 'of-diffstat', job.diffStat));
      const box = el('div', 'of-diff');
      job.diff.split(/(?=^diff --git )/m).filter((f) => f.trim()).forEach((file, i) => {
        const name = (file.match(/^diff --git a\/(.+?) b\//) || [])[1] || 'arquivo';
        const adds = (file.match(/^\+(?!\+\+)/gm) || []).length, dels = (file.match(/^-(?!--)/gm) || []).length;
        const det = el('details');
        det.open = i < 3;
        const sum = el('summary');
        sum.append(el('b', '', name), el('span', 'add-n', ` +${adds}`), el('span', 'del-n', ` −${dels}`));
        const pre = el('pre');
        file.split('\n').filter((l) => !/^(diff --git|index |new file mode|deleted file mode|similarity|rename )/.test(l)).forEach((l) => {
          pre.append(el('span', /^\+(?!\+\+)/.test(l) ? 'add' : /^-(?!--)/.test(l) ? 'del' : /^@@/.test(l) ? 'hunk' : /^(\+\+\+|---)/.test(l) ? 'meta' : '', l || ' '), '\n');
        });
        det.append(sum, pre);
        box.append(det);
      });
      d.append(box);
      if (job.status === 'done' && job.files?.length) {
        const acts = el('div', 'of-bay-actions');
        acts.append(btn('✓ Aplicar', 'primary', async () => { closeModal(); await act('accept', job, `Aplicar ${job.files.length} arquivo(s) no ${job.project}?`); }));
        acts.append(btn('↻ Ajustar', '', () => openAdjust(job)));
        d.append(acts);
      }
    });
  }

  // ---- rodapé: sistema, música, letreiro
  unsub.push(J.onStats(({ cpu, ram }) => {
    cpuHist.push(cpu);
    if (cpuHist.length > 40) cpuHist.shift();
    $('cpu').textContent = `${cpu}%`; $('ram').textContent = `${ram}%`;
    $('cpu').classList.toggle('hot', cpu > 85);
    if (!active) return;
    const c = $('cpuChart'), box = c.getBoundingClientRect();
    const w = Math.round(box.width * devicePixelRatio), h = Math.round(box.height * devicePixelRatio);
    if (w < 10 || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.beginPath();
    cpuHist.forEach((v, i) => { const x = (i / 39) * w, y = h - 1 - (v / 100) * (h - 2); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.strokeStyle = getComputedStyle(root).getPropertyValue('--accent').trim();
    g.lineWidth = 1.5 * devicePixelRatio;
    g.stroke();
  }));
  unsub.push(J.onNowPlaying((s) => {
    $('song').textContent = s ? s.title : 'Nada tocando';
    $('artist').textContent = s ? s.artist : '';
    $('toggle').textContent = s && !s.paused ? '⏸' : '▶';
    if (s?.cover) { if ($('cover').src !== s.cover) $('cover').src = s.cover; } else $('cover').removeAttribute('src');
    $('cover').classList.toggle('spin', !!s && !s.paused);
  }));
  root.querySelectorAll('[data-music]').forEach((b) => b.addEventListener('click', () => J.musicControl(b.dataset.music)));

  async function loadFeed() {
    const f = await J.oficinaFeed().catch(() => null);
    if (!f) return;
    const items = [];
    if (f.weather) items.push(`${f.weather.now.temp}° ${f.weather.now.condition} · ${f.weather.city.split(',')[0]}`);
    if (f.currency) {
      const c = f.currency, arrow = (x) => (x >= 0 ? '▲' : '▼');
      items.push(`USD R$ ${brl(c.usd.value, 4)} ${arrow(c.usd.change)} ${Math.abs(c.usd.change).toFixed(2)}%`);
      items.push(`BTC R$ ${brl(c.btc.value, 0)} ${arrow(c.btc.change)} ${Math.abs(c.btc.change).toFixed(2)}%`);
    }
    (f.news || []).forEach((n) => items.push(`IA · ${n.title}`));
    const track = $('ticker');
    track.innerHTML = '';
    // conteúdo duplicado: a animação rola metade e recomeça sem "pulo"
    for (let k = 0; k < 2; k++) items.forEach((t) => track.append(el('span', /^(USD|BTC)/.test(t) ? (t.includes('▲') ? 'up' : 'down') : '', t)));
    track.style.animationDuration = `${Math.max(40, items.length * 9)}s`;
  }

  // ---- relógio + cronômetros das baias
  function tick() {
    $('clock').textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    bays.forEach((bay, id) => {
      const job = jobOf(id);
      if (job?.status === 'running') bay.refs('body').querySelector('.of-elapsed').textContent = `⏱ ${clock(Date.now() - job.startedAt)}`;
    });
  }

  async function refreshWindowBtn() {
    if (standalone) return;
    const s = await J.oficinaStatus();
    $('winBtn').textContent = s.windowOpen ? '⧉ Aberta no outro monitor' : '⧉ Abrir em janela';
  }

  // ---- ciclo de vida
  async function resume() {
    if (active) return;
    active = true;
    J.oficinaActive(true);
    team = await J.agentState();
    buildBays();
    tick();
    timers.clock = setInterval(tick, 1000);
    timers.feed = setInterval(loadFeed, 600000);
    loadFeed();
    refreshWindowBtn();
  }
  function pause() {
    if (!active) return;
    active = false;
    J.oficinaActive(false);
    ['clock', 'feed'].forEach((k) => clearInterval(timers[k]));
  }
  resume();
  return { resume, pause, destroy() { pause(); unsub.forEach((u) => u()); } };
}

window.Oficina = { mount: mountOficina };
