// Memória por projeto: cada projeto tem uma ficha (contexto, decisões e um diário do que foi feito).
// O diário se preenche sozinho: conversas que mexeram no projeto e o trabalho das agentes/Codex.
// Pendências NÃO ficam aqui: são as tarefas (skills/notes.js) com o campo project.
// Ficam em data/project-memory.json; a ficha do projeto atual entra no prompt de sistema.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_JOURNAL = 80;
const MAX_DECISIONS = 40;
// Ferramentas que, quando usadas, contam como "trabalhei no projeto"
const PROJECT_TOOLS = /^(project_|git_|github_|code_task|codex_|new_project)/;
const QUIET_TOOLS = new Set(['project_list', 'project_recap', 'project_memory_save', 'project_memory_forget', 'codex_status', 'code_task_status']);

let mem = {};
let ctxRef;
const file = () => path.join(ctxRef.dataDir, 'project-memory.json');
const save = () => { ctxRef.writeJson(file(), mem); ctxRef.send('project-memory', null); };
const normalize = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 2) return 'agora há pouco';
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ontem' : `há ${d} dias`;
};

function entry(name) {
  if (!mem[name]) mem[name] = { context: '', decisions: [], journal: [], lastSeen: 0 };
  return mem[name];
}

function git(cwd, ...args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out.toString()));
  });
}

// Projeto citado (ou o atual). Não lança: devolve null se não der para saber.
function projectOf(name) {
  try { return ctxRef.resolveProject(name); } catch { return null; }
}

// Stack lida dos arquivos do projeto (uma vez; vira o contexto inicial da ficha)
function detectStack(dir) {
  const out = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const known = ['react', 'next', 'vue', 'svelte', 'vite', 'typescript', 'tailwindcss', 'express', 'fastify', 'electron', 'prisma', 'three'];
    out.push('Node', ...known.filter((k) => deps.includes(k)));
  } catch {}
  try {
    const req = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8').toLowerCase();
    const known = ['django', 'flask', 'fastapi', 'pandas', 'numpy', 'pytest', 'sqlalchemy', 'requests', 'selenium', 'pyqt5', 'tkinter'];
    out.push('Python', ...known.filter((k) => new RegExp(`^${k}\\b`, 'm').test(req)));
  } catch {}
  if (!out.length && fs.existsSync(path.join(dir, 'pyproject.toml'))) out.push('Python');
  return [...new Set(out)].join(', ');
}

function projectTasks(name) {
  const n = normalize(name);
  const tasks = ctxRef.readJson(path.join(ctxRef.dataDir, 'tasks.json'), []);
  return tasks.filter((t) => !t.done && t.project && (normalize(t.project).includes(n) || n.includes(normalize(t.project))));
}

function projectNotes(name) {
  const n = normalize(name);
  const notes = ctxRef.readJson(path.join(ctxRef.dataDir, 'notes.json'), []);
  return notes.filter((x) => x.project && (normalize(x.project).includes(n) || n.includes(normalize(x.project))));
}

const api = {
  all: () => mem,
  get: (name) => mem[name] || null,

  // Linha no diário do projeto (usada pelas agentes, Codex e pelo fim de cada turno)
  log(name, text, source = 'conversa') {
    if (!name || !text) return;
    const e = entry(name);
    const last = e.journal[e.journal.length - 1];
    // repetição imediata (ex.: "git status" duas vezes) não polui o diário
    if (last && last.text === text && Date.now() - last.at < 10 * 60000) return;
    e.journal.push({ at: Date.now(), text: clip(text, 400), source });
    e.journal = e.journal.slice(-MAX_JOURNAL);
    e.lastSeen = Date.now();
    save();
  },

  // Chamado pelo main.js no fim de cada turno: se o turno mexeu num projeto, vira linha no diário
  journalTurn(userText, reply, turn) {
    const calls = turn.flatMap((m) => m.tool_calls || []).filter((c) => PROJECT_TOOLS.test(c.function.name));
    const meaningful = calls.filter((c) => !QUIET_TOOLS.has(c.function.name));
    if (!meaningful.length) return;
    let named = null;
    for (const c of meaningful) {
      try { named = JSON.parse(c.function.arguments || '{}').project || named; } catch {}
    }
    const p = projectOf(named);
    if (!p) return;
    const tools = [...new Set(meaningful.map((c) => c.function.name))].join(', ');
    api.log(p.name, `"${clip(userText, 160)}" → ${tools}${reply ? ` · ${clip(reply, 140)}` : ''}`);
  },

  setContext(name, text) { entry(name).context = clip(text, 600); save(); },

  addDecision(name, text) {
    const e = entry(name);
    if (e.decisions.some((d) => normalize(d.text) === normalize(text))) return null;
    const d = { id: newId(), text: clip(text, 300), at: Date.now() };
    e.decisions.push(d);
    e.decisions = e.decisions.slice(-MAX_DECISIONS);
    save();
    return d;
  },

  removeItem(name, id) {
    const e = mem[name];
    if (!e) return false;
    const before = e.decisions.length + e.journal.length;
    e.decisions = e.decisions.filter((d) => d.id !== id);
    e.journal = e.journal.filter((j) => String(j.at) !== String(id));
    save();
    return before !== e.decisions.length + e.journal.length;
  },

  // Dados da tela de Projetos: ficha + pendências de cada projeto
  overview(names) {
    const out = {};
    for (const n of names) {
      const e = mem[n] || { context: '', decisions: [], journal: [] };
      out[n] = { context: e.context, decisions: e.decisions.slice(-8), journal: e.journal.slice(-6).reverse(), tasks: projectTasks(n).map((t) => ({ id: t.id, text: t.text })) };
    }
    return out;
  },

  // Bloco do prompt de sistema: só o projeto atual, curto
  promptBlock() {
    const cur = ctxRef.config.currentProject;
    if (!cur) return '';
    const name = path.basename(cur);
    const e = mem[name];
    const tasks = projectTasks(name);
    if (!e && !tasks.length) return '';
    const lines = [];
    if (e?.context) lines.push(`Contexto: ${e.context}`);
    if (e?.decisions.length) lines.push(`Decisões: ${e.decisions.slice(-8).map((d) => d.text).join('; ')}`);
    if (tasks.length) lines.push(`Pendências: ${tasks.slice(-8).map((t) => t.text).join('; ')}`);
    const last = e?.journal[e.journal.length - 1];
    if (last) lines.push(`Última atividade (${ago(last.at)}): ${clip(last.text, 200)}`);
    return `\nMemória do projeto atual (${name}):\n${lines.map((l) => `- ${l}`).join('\n')}\n`;
  },

  // "Onde eu parei?": ficha + estado do git + diário, tudo junto
  async recap(name) {
    const p = projectOf(name);
    if (!p) throw new Error('Não sei de qual projeto você está falando');
    const e = entry(p.name);
    if (!e.context) {
      const stack = detectStack(p.path);
      if (stack) { e.context = `Stack: ${stack}`; save(); }
    }
    const out = {
      project: p.name,
      context: e.context || null,
      decisions: e.decisions.slice(-10).map((d) => d.text),
      pending_tasks: projectTasks(p.name).map((t) => t.text),
      notes: projectNotes(p.name).slice(-5).map((n) => n.text),
      journal: e.journal.slice(-12).map((j) => `${ago(j.at)} [${j.source}] ${j.text}`),
    };
    if (fs.existsSync(path.join(p.path, '.git'))) {
      const [branch, log, status, stat] = await Promise.all([
        git(p.path, 'branch', '--show-current'),
        git(p.path, 'log', '-6', '--pretty=%s (%ar)'),
        git(p.path, 'status', '--porcelain=v1'),
        git(p.path, 'diff', '--shortstat'),
      ]);
      const changed = status.trim().split('\n').filter(Boolean);
      out.git = {
        branch: branch.trim(),
        recent_commits: log.trim().split('\n').filter(Boolean),
        uncommitted_files: changed.slice(0, 15).map((l) => l.slice(3)),
        uncommitted_count: changed.length,
        diff: stat.trim() || null,
      };
    }
    e.lastSeen = Date.now();
    save();
    out.instruction = 'Fale em 2 a 3 frases: onde ele parou (o mais recente entre diário, commits e arquivos não commitados) e o próximo passo provável (uma pendência ou o que ficou pela metade). Se houver muita coisa, mande a lista com show_in_chat.';
    return out;
  },
};

const projectParam = { type: 'string', description: 'Nome do projeto; omita para usar o projeto atual' };

module.exports = {
  name: 'projmem',
  api,
  init(ctx) {
    ctxRef = ctx;
    mem = ctx.readJson(file(), {});
    ctx.projectMemory = api;
  },
  tools: [
    {
      name: 'project_recap',
      description: 'Situa o usuário num projeto: "onde eu parei no X?", "o que eu tava fazendo?", "me situa no projeto", "retoma o CAMPEX". Junta a memória do projeto (decisões, pendências, diário) com o estado do git.',
      parameters: { type: 'object', properties: { project: projectParam } },
      async run({ project }) { return api.recap(project); },
    },
    {
      name: 'project_memory_save',
      description: 'Guarda algo duradouro na memória de um projeto. kind "decisao": escolha técnica ou de produto ("vamos usar Postgres", "o login vai ser só com Google"). kind "contexto": o que o projeto é, para quem, stack (SUBSTITUI o contexto anterior; escreva o contexto completo). kind "progresso": marco importante concluído que deve ficar no diário. Pendências NÃO: use task_add com project. Escreva curto, em 3ª pessoa.',
      parameters: {
        type: 'object',
        properties: { project: projectParam, kind: { type: 'string', enum: ['decisao', 'contexto', 'progresso'] }, text: { type: 'string' } },
        required: ['kind', 'text'],
      },
      async run({ project, kind, text }) {
        const p = projectOf(project);
        if (!p) return { ok: false, error: 'Qual projeto?' };
        if (kind === 'contexto') { api.setContext(p.name, text); return { ok: true, project: p.name, context: text }; }
        if (kind === 'progresso') { api.log(p.name, text, 'marco'); return { ok: true, project: p.name, logged: text }; }
        const d = api.addDecision(p.name, text);
        return d ? { ok: true, project: p.name, decision: d.text } : { ok: true, already_known: true };
      },
    },
    {
      name: 'project_memory_forget',
      description: 'Remove uma decisão da memória de um projeto ("esquece a decisão do Postgres", "não vamos mais usar X").',
      parameters: { type: 'object', properties: { project: projectParam, text: { type: 'string', description: 'A decisão ou parte dela' } }, required: ['text'] },
      async run({ project, text }) {
        const p = projectOf(project);
        const e = p && mem[p.name];
        if (!e?.decisions.length) return { ok: false, error: 'Não há decisões guardadas nesse projeto' };
        const words = normalize(text).split(' ').filter((w) => w.length > 2);
        let best = null, bestScore = 0;
        for (const d of e.decisions) {
          const score = words.filter((w) => normalize(d.text).includes(w)).length;
          if (score > bestScore) { best = d; bestScore = score; }
        }
        if (!best) return { ok: false, error: 'Não encontrei essa decisão' };
        api.removeItem(p.name, best.id);
        return { ok: true, forgot: best.text };
      },
    },
  ],
};
